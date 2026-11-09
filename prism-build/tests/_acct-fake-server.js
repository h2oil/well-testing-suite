'use strict';
// prism-build/tests/_acct-fake-server.js — the in-memory fake accounts API for client tests (docs/ACCOUNTS-PLAN.md §12.1).
//
// It runs the REAL request pipeline of server/core/app.js (Origin / header / content-type rules, body caps, contract request
// shapes, the error envelope, the constant 303 callback, ACCOUNTS_OFF) with in-memory handlers that implement the §3
// contract: e-mail codes (two live, 5 tries, purposes and bindings), consent and the invite allow-list, sessions with the
// 30 s rotation grace and step-up (`stepupAt` only from a code), e-mail change and 7-day revert, recovery address, sign-out
// and sign-out-all, provider sign-in through server/test/fake-oidc.js (start → authorize → callback → finish with the
// linking rules of §4.12, attempt extension, link-confirm, cancel-deletion, breaker and ceilings), methods / unlink, me,
// devices, library, projects (CAS, pushId receipts, inline core, missing blobs, vhash no-op, trash, history, duplicate),
// blobs (chunked, immutable), quota, export, delete with grace and cancel, kill switches and fault modes.
// Passkeys are Phase 3: their routes answer 501 not_implemented, as the WP0 server does.
//
//   const F = require('./_acct-fake-server');
//   const fake = F.createFakeServer({ now, switches:{ACCOUNTS_SIGNUP:'open', OAUTH_GOOGLE:'on', …}, allow:[emails], mailDelay,
//                                     latency:{ms, schedule:(fn, ms) => app.win.setTimeout(fn, ms)}, origin });
//   loadApp({ globals: { fetch: fake.fetch, location: F.prodLocation() } })     // one browser = one cookie jar
//   fake.browser()           → another browser {fetch, navigate, visit, jar, cookie, restart}   (a second device);
//   fake.restart() / br.restart() — a browser restart: cookies without Max-Age are dropped (the session cookie has one)
//   fake.visit(url, {as:{key, email, email_verified, hd}} | {cancel:true})  → the provider round trip of a location.assign(url):
//                              authorize at the fake provider, then the cross-site callback (Lax cookies only) → {status, location}
//   fake.mail.sent / fake.codeFor(email, template?) / fake.lastMail(email)
//   fake.fault({path, method, mode, times})   modes: an error code of the contract ('signed_out', 'reauth', 'stale', 'rate', …),
//                              'server' (500), 'network' (fetch rejects, nothing processed), 'lost' (processed, then rejects)
//   fake.setSwitch(name, value), fake.allow(email), fake.oidc.google / .linkedin, fake.state, fake.handle(req), fake.requests
//
// Test helpers: prodLocation(path?) — the whole location object for https://welltest.h2oil.co.uk (the harness replaces the
// whole object, so every field is given); signIn(fake, browser, email, {consent}) — a code sign-in for tests that need a session.

const path = require('path');
const crypto = require('crypto');
const SRV = path.join(__dirname, '..', '..', 'server');
const C = require(path.join(SRV, 'core', 'contract'));
const H = require(path.join(SRV, 'core', 'http'));
const V = require(path.join(SRV, 'core', 'validate'));
const { ApiError } = require(path.join(SRV, 'core', 'errors'));
const { createApp } = require(path.join(SRV, 'core', 'app'));
const { loadConfig } = require(path.join(SRV, 'core', 'config'));
const { memoryTransport } = require(path.join(SRV, 'core', 'mail'));
const PINS = require(path.join(SRV, 'core', 'oidc-providers'));
const { createFakeOidc, decodeJwt, fromB64u } = require(path.join(SRV, 'test', 'fake-oidc'));

const PROD = 'https://welltest.h2oil.co.uk';
const MIN = 60 * 1000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const fail = (code, extra) => { throw new ApiError(code, extra); };
const uuid = () => crypto.randomUUID();
const rnd = (n) => crypto.randomBytes(n).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const code8 = () => String(crypto.randomInt(0, 1e8)).padStart(8, '0');
const { revertKey } = require(path.join(SRV, 'core', 'keys'));

function prodLocation(p) {
  const pathname = p || '/well-testing-app.html';
  return { href: PROD + pathname, origin: PROD, protocol: 'https:', host: 'welltest.h2oil.co.uk', hostname: 'welltest.h2oil.co.uk',
    port: '', pathname, search: '', hash: '', reload() {}, assign() {}, replace() {}, toString() { return this.href; } };
}

function createFakeServer(o) {
  o = o || {};
  const now = o.now || (() => Date.now());
  const iso = (ms) => new Date(ms == null ? now() : ms).toISOString();
  const origin = o.origin || PROD;
  const mail = memoryTransport(o.mailDelay ? { delay: o.mailDelay } : {});   // mailDelay(resolve): a slow or stuck mailer
  const oidc = {
    google: createFakeOidc({ provider: 'google', now }),
    linkedin: createFakeOidc({ provider: 'linkedin', now, enforcePkce: o.linkedinPkce !== false }),
  };
  const env = Object.assign({
    WTS_ENV: 'test', ACCOUNTS_SIGNUP: 'open', SYNC_MODE: 'on', OAUTH_GOOGLE: 'on', OAUTH_LINKEDIN: 'on',
    OAUTH_GOOGLE_CLIENT_ID: oidc.google.clientId, OAUTH_GOOGLE_CLIENT_SECRET: oidc.google.clientSecret,
    OAUTH_LINKEDIN_CLIENT_ID: oidc.linkedin.clientId, OAUTH_LINKEDIN_CLIENT_SECRET: oidc.linkedin.clientSecret,
    WTS_TERMS_VERSION: '1', WTS_PRIVACY_VERSION: '1', WTS_VERSION: 'fake',
  }, o.switches || {});
  if (origin !== PROD) env.WTS_DEV_ORIGIN = origin;
  const S = {
    users: new Map(), byEmail: new Map(), sessions: new Map(), devices: new Map(), identities: new Map(), codes: [],
    attempts: new Map(), projects: new Map(), blobs: new Map(), receipts: new Map(), allow: new Set((o.allow || []).map(V.normEmail)),
    audit: [], breaker: { google: { win: [], openUntil: 0 }, linkedin: { win: [], openUntil: 0 } }, prefixExchanges: [],
  };
  const faults = [];
  const requests = [];
  let config; let app;
  function rebuild() { config = loadConfig(env); app = createApp({ config, handlers: HANDLERS, now }); }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const userOf = (id) => S.users.get(id);
  function findAccount(email) { const e = S.byEmail.get(email); return e ? { user: userOf(e.userId), role: e.role } : null; }
  function setEmailIndex(u) {
    for (const [k, v] of S.byEmail) if (v.userId === u.id) S.byEmail.delete(k);
    S.byEmail.set(u.email, { userId: u.id, role: 'primary' });
    if (u.recovery) S.byEmail.set(u.recovery, { userId: u.id, role: 'recovery' });
  }
  function audit(userId, action, detail) { S.audit.push({ userId, actor: 'user', action, at: iso(), detail: detail || {} }); }
  function send(to, template, params) { return mail.send({ to, template, params: Object.assign({ at: iso(), browser: 'Browser', os: 'OS' }, params || {}) }); }
  function liveCodes(f) { const t = now(); return S.codes.filter((c) => !c.used && !c.invalidated && c.expires > t && f(c)); }
  function issueCode(email, purpose, bind, template, params) {
    bind = bind || {};
    const same = liveCodes((c) => c.email === email && c.purpose === purpose && c.boundAttempt === (bind.attempt || null));
    if (same.length >= 2) same.slice(0, same.length - 1).forEach((c) => { c.invalidated = true; });
    const c = { id: uuid(), email, purpose, code: code8(), boundUser: bind.user || null, boundSid: bind.sid || null,
      boundAttempt: bind.attempt || null, expires: now() + 15 * MIN, attempts: 0, used: false, invalidated: false };
    S.codes.push(c);
    send(email, template, Object.assign({ code: c.code }, params || {}));
    return c;
  }
  // Try a code against the live codes selected by f; a miss counts one try on each (5 tries each).
  function takeCode(f, code) {
    const live = liveCodes(f);
    const hit = live.find((c) => H.safeEqual(c.code, code));
    if (!hit) { live.forEach((c) => { c.attempts++; if (c.attempts >= 5) c.invalidated = true; }); return null; }
    hit.used = true;
    live.forEach((c) => { if (c !== hit && c.purpose === hit.purpose) c.invalidated = true; });
    return hit;
  }
  function deviceFor(u, ctx, label, publicDevice) {
    const asked = H.header(ctx.req, 'x-wts-device');
    const k = u.id + '|' + asked;
    let d = asked && S.devices.get(k);
    const isNew = !d;
    if (!d) { d = { id: uuid(), userId: u.id, label: (label || '').slice(0, 40), firstSeen: iso(), lastSeen: iso(), publicDevice: !!publicDevice, revoked: false }; S.devices.set(u.id + '|' + d.id, d); }
    d.lastSeen = iso(); if (label) d.label = label;
    return { d, isNew };
  }
  function revokeSession(sid) { S.sessions.delete(sid); }
  // the session cookie's Max-Age = whole seconds to abs_expires_at (contract COOKIES.session), at least 1
  function sessionMaxAge(s) { return Math.max(1, Math.ceil((s.absExp - now()) / 1000)); }
  function revokeWhere(f) { let n = 0; for (const [sid, s] of S.sessions) if (f(s)) { S.sessions.delete(sid); n++; } return n; }
  function newSession(ctx, u, o2) {
    const presented = ctx.cookies[C.COOKIES.session.name];
    if (presented) revokeSession(presented);                 // a sign-in always revokes the session the request carried
    const sid = rnd(32);
    const pub = !!o2.publicDevice;
    const s = { sid, userId: u.id, deviceId: o2.deviceId, publicDevice: pub, createdAt: now(), authAt: now(),
      stepupAt: o2.stepup ? now() : null, authMethod: o2.method || 'code', identityId: o2.identityId || null,
      lastSeen: now(), idleExp: now() + (pub ? 12 * HOUR : 35 * DAY), absExp: now() + (pub ? 7 * DAY : 180 * DAY), replacedAt: null };
    S.sessions.set(sid, s);
    ctx.setCookie(C.COOKIES.session, sid, { maxAge: sessionMaxAge(s) });
    u.lastSignInAt = iso();
    return s;
  }
  function rotate(ctx, s) {
    const sid = rnd(32);
    const n = Object.assign({}, s, { sid, replacedAt: null });
    S.sessions.set(sid, n);
    s.replacedAt = now(); s.replacedBy = sid;
    ctx.setCookie(C.COOKIES.session, sid, { maxAge: sessionMaxAge(n) });
    return n;
  }
  function sessionOf(ctx, opt) {
    const sid = ctx.cookies[C.COOKIES.session.name];
    let s = sid && S.sessions.get(sid);
    if (s && s.replacedAt && now() - s.replacedAt > 30 * 1000) { S.sessions.delete(sid); s = null; }
    if (s && s.replacedAt) s = S.sessions.get(s.replacedBy) || null;
    if (s && (now() > s.idleExp || now() > s.absExp)) { S.sessions.delete(s.sid); s = null; }
    const u = s && userOf(s.userId);
    if (!s || !u) { if (opt && opt.optional) return null; fail('signed_out'); }
    if (u.status === 'locked') fail('locked');
    s.lastSeen = now(); s.idleExp = now() + (s.publicDevice ? 12 * HOUR : 35 * DAY);
    return { s, u };
  }
  function needStepup(s) { if (!s.stepupAt || now() - s.stepupAt > 10 * MIN) fail('reauth'); }
  function syncGate(write) {
    if (config.syncMode === 'off') fail('paused');
    if (write && config.syncMode === 'readonly') fail('readonly');
  }
  function notDeleting(u) { if (u.status === 'deleting') fail('gone'); }
  function signInBody(u, s, d, first) {
    return { user: { id: u.id, emailMasked: V.maskEmail(u.email), created: u.created }, firstSignIn: !!first,
      device: { id: d.id, label: d.label }, session: { publicDevice: s.publicDevice, idleExpires: iso(s.idleExp), absExpires: iso(s.absExp) } };
  }
  function createUser(email, method, consentAt) {
    const u = { id: uuid(), email, recovery: null, status: 'active', created: iso(), signupMethod: method, terms: config.terms,
      privacy: config.privacy, consentedAt: consentAt || iso(), quota: o.quota || 250000000, used: 0, opts: { historian: false, liveCfg: false },
      lib: { rev: 0, hash: null, savedAt: null, body: null }, deleteAt: null, outboxKey: crypto.randomBytes(32).toString('base64'),
      emailChangedAt: null, prev: null, pendingEmail: null, pendingRecovery: null, lastSignInAt: null, profile: null };
    S.users.set(u.id, u); setEmailIndex(u);
    audit(u.id, 'signup', { method });
    return u;
  }
  // user insight: the optional profile (ProfileReq, already shape-checked) → the stored profile; empty strings → null
  const PROFILE_KEYS = ['fullName', 'company', 'jobTitle', 'country', 'phone'];
  function profileOf(p, prev) {
    const out = {}; PROFILE_KEYS.forEach((k) => { out[k] = prev ? prev[k] : null; });
    PROFILE_KEYS.forEach((k) => { if (p && p[k] !== undefined) { const v = p[k] == null ? '' : String(p[k]).trim(); out[k] = v ? v : null; } });
    return out;
  }
  function consentOk(c) { return !!c && c.terms === config.terms && c.privacy === config.privacy; }
  function signupAllowed(email) {
    if (config.signup === 'off') return 'signup_closed';
    if (config.signup === 'invite' && !S.allow.has(email)) return 'not_invited';
    return null;
  }
  function identityList(userId) { return Array.from(S.identities.values()).filter((i) => i.userId === userId); }
  function methodsOf(u) {
    const m = { email: { masked: V.maskEmail(u.email) }, identities: identityList(u.id).map((i) => ({ id: i.id, provider: i.provider,
      emailMasked: i.email ? V.maskEmail(i.email) : null, linkedAt: i.linkedAt, lastUsedAt: i.lastUsedAt })), passkeys: [] };
    if (u.recovery) m.recovery = { masked: V.maskEmail(u.recovery) };
    return m;
  }
  function removeIdentity(i) {
    S.identities.delete(i.id);
    const n = revokeWhere((s) => s.identityId === i.id);
    audit(i.userId, 'identity_unlink', { provider: i.provider, identity_id: i.id });
    return n;
  }
  function linkIdentity(u, a, via) {
    const r = a.result;
    const i = { id: uuid(), userId: u.id, provider: a.provider, issuer: r.iss, subject: r.sub, email: r.email || null,
      emailVerifiedAtLink: !!r.emailVerified, linkedAt: iso(), linkedVia: via, lastUsedAt: null, ackEmail: null };
    S.identities.set(i.id, i);
    audit(u.id, 'identity_link', { provider: a.provider, via, identity_id: i.id });
    send(u.email, 'notice_identity_linked', { provider: a.provider });
    return i;
  }
  const identityBySub = (p, sub) => Array.from(S.identities.values()).find((i) => i.provider === p && i.subject === sub) || null;

  // ── projects and blobs ───────────────────────────────────────────────────────────────────────────────────────────
  const blobKey = (uid, h) => uid + '|' + h;
  function blobComplete(uid, h) { const b = S.blobs.get(blobKey(uid, h)); return !!(b && b.complete); }
  function projectOf(u, id, opt) {
    const p = S.projects.get(id);
    if (!p || p.userId !== u.id || p.purged) fail('not_found');
    if (p.trashed && !(opt && opt.trash)) fail('gone');
    return p;
  }
  function headBody(p, r) {
    if (!r) return { rev: 0, savedAt: null, device: null, coreHash: null, vhash: null, parts: [], bytes: 0 };
    const b = { rev: r.rev, savedAt: r.savedAt, device: r.device, coreHash: r.coreHash, vhash: r.vhash, parts: r.parts, bytes: r.bytes };
    if (r.coreInline) b.coreInline = r.coreInline;
    return b;
  }
  const headOf = (p) => p.revs[p.revs.length - 1] || null;
  function listItem(p) {
    const h = headOf(p);
    const it = { id: p.id, name: p.name, meta: p.meta, wells: p.wells, headRev: h ? h.rev : 0, savedAt: h ? h.savedAt : null,
      savedBy: { device: h ? h.device : null }, bytes: h ? h.bytes : 0 };
    if (p.conflictOf) it.conflictOf = p.conflictOf;
    return it;
  }
  function usedBytes(uid) { let n = 0; for (const b of S.blobs.values()) if (b.userId === uid && b.complete) n += b.zbytes; return n; }

  // ── provider sign-in ─────────────────────────────────────────────────────────────────────────────────────────────
  function provCfg(p) { return PINS.resolve(p, { override: oidc[p].override }); }
  function breakerOpen(p) { return S.breaker[p].openUntil > now(); }
  function providerState(p) { const sw = config.providerSwitches()[p]; return sw !== 'off' && breakerOpen(p) ? 'off' : sw; }
  function noteExchange(p, providerFailure) {
    const b = S.breaker[p]; const t = now();
    b.win = b.win.filter((x) => t - x.at < 10 * MIN); b.win.push({ at: t, bad: !!providerFailure });
    const bad = b.win.filter((x) => x.bad).length;
    if (b.win.length >= 20 && bad / b.win.length > 0.5) b.openUntil = t + 10 * MIN;
  }
  function attemptFromCookie(ctx) {
    const v = ctx.cookies[C.COOKIES.attemptLax.name];
    if (!v) return null;
    for (const a of S.attempts.values()) if (a.cookie === v) return a;
    return null;
  }
  function checkIdToken(p, token, a) {
    const op = oidc[p]; const cfg = provCfg(p);
    let jwt;
    try { jwt = decodeJwt(token); } catch (e) { return { fail: 'token' }; }
    if (jwt.header.alg !== 'RS256') return { fail: 'token' };
    let jwk = op.jwks().keys.find((k) => k.kid === jwt.header.kid);
    if (!jwk) jwk = op.jwks().keys.find((k) => k.kid === jwt.header.kid);            // the one refetch
    if (!jwk) return { fail: 'token' };
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (!crypto.verify('RSA-SHA256', Buffer.from(jwt.signingInput), pub, jwt.signature)) return { fail: 'token' };
    const c = jwt.payload; const t = Math.floor(now() / 1000);
    if (cfg.issuers.indexOf(c.iss) === -1) return { fail: 'token' };
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (aud.indexOf(op.clientId) === -1 || aud.some((x) => x !== op.clientId)) return { fail: 'token' };
    if (c.azp !== undefined && c.azp !== op.clientId) return { fail: 'token' };
    if (!(c.exp > t - 60) || !(c.iat <= t + 60) || t - c.iat > 600 + 60) return { fail: 'token' };
    if (c.nonce !== undefined || cfg.nonce === 'required') { if (!H.safeEqual(c.nonce, a.nonce)) return { fail: 'token' }; }
    if (a.freshLogin && (typeof c.auth_time !== 'number' || c.auth_time < Math.floor(a.createdAt / 1000) - 60)) return { fail: 'reauth_stale' };
    if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) return { fail: 'token' };
    const email = c.email ? V.normEmail(c.email) : null;
    const ev = email ? (c.email_verified === true || c.email_verified === 'true') : false;
    return { iss: c.iss, sub: c.sub, email, emailVerified: ev, hd: typeof c.hd === 'string' ? c.hd.toLowerCase() : null, authTime: c.auth_time || null };
  }
  function trusted(p, r) {
    const cfg = provCfg(p);
    if (!cfg.trustEmailVerified || !r.email || !r.emailVerified) return false;
    const dom = V.domainOf(r.email);
    return cfg.consumerDomains.indexOf(dom) !== -1 || (!!r.hd && r.hd === dom);
  }
  function stepTo(ctx, a, next, body, codeExpiry) {
    a.step = next;
    a.cookie = rnd(32);
    a.resultExpires = Math.min(a.createdAt + 30 * MIN, (codeExpiry || now() + 15 * MIN) + 5 * MIN);
    ctx.setCookie(C.COOKIES.attemptStrict, a.cookie);
    return { status: 200, body: Object.assign({ next }, body) };
  }
  function endAttempt(ctx, a) { a.finished = true; S.attempts.delete(a.id); ctx.setCookie(C.COOKIES.attemptLax, null); }
  function statusGate(ctx, a, u) {
    if (u.status === 'locked') { endAttempt(ctx, a); fail('locked'); }
    if (u.status === 'deleting') {
      a.pending = { email: u.email, userId: u.id, reason: 'cancel_deletion' };
      const c = issueCode(u.email, 'oauth_verify', { attempt: a.id }, 'code_cancel_deletion');
      return stepTo(ctx, a, 'code', { emailMasked: V.maskEmail(u.email), reason: 'cancel_deletion' }, c.expires);
    }
    return null;
  }
  function providerSignIn(ctx, a, u, identity, o2) {
    const { d } = deviceFor(u, ctx, a.deviceLabel, a.publicDevice);
    const s = newSession(ctx, u, { publicDevice: a.publicDevice, deviceId: d.id, method: a.provider, identityId: identity.id, stepup: !!o2.stepup });
    identity.lastUsedAt = iso();
    let differs = false;
    if (a.result.email && identity.email !== a.result.email && identity.ackEmail !== a.result.email) differs = true;
    audit(u.id, 'signin', { method: a.provider });
    endAttempt(ctx, a);
    return { status: 200, body: Object.assign({ next: 'done' }, signInBody(u, s, d, !!o2.first), { method: a.provider, providerEmailDiffers: differs }) };
  }

  // ── handlers (one per contract endpoint id) ─────────────────────────────────────────────────────────────────────
  const notImpl = () => fail('not_implemented');
  const HANDLERS = {
    health: () => ({ status: 200, body: { ok: true, db: true, ver: config.version } }),
    providers: () => ({ status: 200, body: { google: providerState('google'), linkedin: providerState('linkedin') } }),
    codeStart(ctx) {
      const b = ctx.body; const email = b.email === undefined ? null : V.normEmail(b.email);
      if (!email && b.purpose !== 'stepup') fail('bad_request', { field: 'email' });
      if (b.purpose === 'signin') {
        const acc = findAccount(email);
        if (acc && acc.user.status !== 'locked') issueCode(email, 'signin', {}, 'code_signin');
        else if (!acc && !signupAllowed(email)) issueCode(email, 'signin', {}, 'code_signin');
      } else if (b.purpose === 'stepup') {
        const ss = sessionOf(ctx, { optional: true });
        if (ss) {
          const to = b.to === 'recovery' && ss.u.recovery ? ss.u.recovery : ss.u.email;
          issueCode(to, 'stepup', { user: ss.u.id, sid: ss.s.sid }, 'code_stepup');
        }
      } else {
        const ss = sessionOf(ctx, { optional: true });
        const pend = ss && (b.purpose === 'email_change' ? ss.u.pendingEmail : ss.u.pendingRecovery);
        if (pend && pend === email) issueCode(email, b.purpose, { user: ss.u.id, sid: ss.s.sid }, b.purpose === 'email_change' ? 'code_email_change' : 'code_recovery_add');
      }
      return { status: 202, body: { ok: true } };
    },
    codeVerify(ctx) {
      const b = ctx.body; const email = V.normEmail(b.email); const code = V.normCode(b.code);
      const ss = sessionOf(ctx, { optional: true });
      if (ss) {
        const hit = takeCode((c) => c.purpose === 'stepup' && c.boundUser === ss.u.id && c.boundSid === ss.s.sid, code);
        if (hit) {
          const n = rotate(ctx, ss.s); n.stepupAt = now();
          const d = S.devices.get(ss.u.id + '|' + n.deviceId) || deviceFor(ss.u, ctx, b.deviceLabel, n.publicDevice).d;
          return { status: 200, body: signInBody(ss.u, n, d, false) };
        }
      }
      if (!email) fail('invalid_or_expired');
      const acc = findAccount(email);
      if (!acc && !consentOk(b.consent)) {
        if (!liveCodes((c) => c.email === email && c.purpose === 'signin').some((c) => H.safeEqual(c.code, code))) fail('invalid_or_expired');
        fail('consent_required', { terms: config.terms, privacy: config.privacy });
      }
      const hit = takeCode((c) => c.email === email && c.purpose === 'signin', code);
      if (!hit) fail('invalid_or_expired');
      let u = acc && acc.user; let first = false;
      if (u && u.status === 'locked') fail('locked');
      // an existing account on older Terms / Privacy versions (test switch u.staleConsent, like the server's version check):
      // 409 with existing: true and the code kept, until the current versions come with the request
      if (u && u.staleConsent) {
        if (!consentOk(b.consent)) { hit.used = false; fail('consent_required', { terms: config.terms, privacy: config.privacy, existing: true }); }
        u.staleConsent = false;
      }
      if (!u) {
        if (signupAllowed(email)) fail('invalid_or_expired');
        u = createUser(email, 'code'); first = true;
        if (b.profile) u.profile = profileOf(b.profile);
      }
      const { d, isNew } = deviceFor(u, ctx, b.deviceLabel, b.publicDevice);
      const s = newSession(ctx, u, { publicDevice: b.publicDevice, deviceId: d.id, method: 'code', stepup: true });
      if (isNew && !first) send(u.email, 'notice_new_device');
      audit(u.id, 'signin', { method: 'code' });
      return { status: 200, body: signInBody(u, s, d, first) };
    },
    emailChange(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      const e = V.normEmail(ctx.body.newEmail);
      if (!e) fail('bad_request', { field: 'newEmail' });
      if (!findAccount(e)) { u.pendingEmail = e; issueCode(e, 'email_change', { user: u.id, sid: s.sid }, 'code_email_change'); }
      return { status: 202, body: { ok: true } };
    },
    emailConfirm(ctx) {
      const { s, u } = sessionOf(ctx);
      const hit = takeCode((c) => c.purpose === 'email_change' && c.boundUser === u.id && c.boundSid === s.sid, V.normCode(ctx.body.code));
      if (!hit || findAccount(hit.email)) fail('invalid_or_expired');
      const old = u.email;
      u.prev = { email: old, revertCode: revertKey(), until: now() + 7 * DAY };
      u.email = hit.email; u.emailChangedAt = now(); u.pendingEmail = null;
      setEmailIndex(u);
      revokeWhere((x) => x.userId === u.id && x.sid !== s.sid);
      send(old, 'notice_email_changed', { revertCode: u.prev.revertCode });
      audit(u.id, 'email_change', {});
      return { status: 200, body: { emailMasked: V.maskEmail(u.email) } };
    },
    emailRevert(ctx) {
      const old = V.normEmail(ctx.body.email); const code = V.normRevertKey(ctx.body.code) || '-';
      const u = Array.from(S.users.values()).find((x) => x.prev && x.prev.email === old && x.prev.until > now() && H.safeEqual(x.prev.revertCode, code));
      if (!u || (findAccount(old) && findAccount(old).user !== u)) fail('invalid_or_expired');
      const since = u.emailChangedAt;
      u.email = old; u.prev = null; u.recovery = null; setEmailIndex(u);
      const sessions = revokeWhere((x) => x.userId === u.id);
      let identitiesRemoved = 0;
      identityList(u.id).forEach((i) => { if (Date.parse(i.linkedAt) > since) { removeIdentity(i); identitiesRemoved++; } });
      const { d } = deviceFor(u, ctx, '', false);
      newSession(ctx, u, { publicDevice: false, deviceId: d.id, method: 'code', stepup: true });
      send(u.email, 'notice_email_reverted');
      audit(u.id, 'email_revert', {});
      return { status: 200, body: { ok: true, sessions, passkeysRemoved: 0, identitiesRemoved } };
    },
    recoverySet(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      if (ctx.body.email !== undefined) {
        const e = V.normEmail(ctx.body.email);
        if (!findAccount(e)) { u.pendingRecovery = e; issueCode(e, 'recovery_add', { user: u.id, sid: s.sid }, 'code_recovery_add'); }
        return { status: 202, body: { ok: true } };
      }
      const hit = takeCode((c) => c.purpose === 'recovery_add' && c.boundUser === u.id && c.boundSid === s.sid, V.normCode(ctx.body.code));
      if (!hit || findAccount(hit.email)) fail('invalid_or_expired');
      u.recovery = hit.email; u.pendingRecovery = null; setEmailIndex(u);
      send(u.email, 'notice_recovery_set'); send(u.recovery, 'notice_recovery_set');
      return { status: 200, body: { ok: true } };
    },
    recoveryRemove(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      if (u.recovery) { const r = u.recovery; u.recovery = null; setEmailIndex(u); send(u.email, 'notice_recovery_removed'); send(r, 'notice_recovery_removed'); }
      return { status: 200, body: { ok: true } };
    },
    passkeyOptions: notImpl, passkeyVerify: notImpl, passkeyRegisterOptions: notImpl, passkeyRegisterVerify: notImpl,
    passkeyRename: notImpl, passkeyRemove: notImpl,
    signOut(ctx) {
      const sid = ctx.cookies[C.COOKIES.session.name];
      if (sid) revokeSession(sid);
      ctx.setCookie(C.COOKIES.session, null);
      return { status: 200, body: { ok: true } };
    },
    signOutAll(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      let identitiesRemoved = 0;
      const days = ctx.body.alsoRecentMethodsDays;
      if (days) identityList(u.id).forEach((i) => { if (now() - Date.parse(i.linkedAt) <= days * DAY) { removeIdentity(i); identitiesRemoved++; } });
      const sessions = revokeWhere((x) => x.userId === u.id);
      ctx.setCookie(C.COOKIES.session, null);
      send(u.email, 'notice_signout_all');
      return { status: 200, body: { ok: true, sessions, passkeysRemoved: 0, identitiesRemoved } };
    },
    oauthStart(ctx) {
      const p = ctx.params.provider; const b = ctx.body;
      const st = providerState(p);
      if (st === 'off') fail('provider_off', { provider: p });
      let bound = null;
      if (b.purpose === 'link') {
        if (st === 'signin') fail('provider_off', { provider: p });
        bound = sessionOf(ctx); needStepup(bound.s);
      }
      const cfg = provCfg(p);
      const fresh = !!(b.publicDevice || b.sharedBrowser);
      if (fresh && !cfg.freshLogin) fail('oauth_failed', { reason: 'reauth_stale' });
      const live = Array.from(S.attempts.values()).filter((a) => a.ipPrefix === ctx.ipPrefix && !a.used && a.expiresAt > now());
      if (live.length >= 20) fail('provider_off', { provider: p });
      const old = attemptFromCookie(ctx); if (old) S.attempts.delete(old.id);
      const verifier = rnd(48);
      const a = { id: uuid(), cookie: rnd(32), provider: p, purpose: b.purpose, state: rnd(32), nonce: rnd(32), verifier,
        boundSid: bound ? bound.s.sid : null, boundUser: bound ? bound.u.id : null, publicDevice: !!b.publicDevice, freshLogin: fresh,
        deviceLabel: b.deviceLabel || '', createdAt: now(), expiresAt: now() + 10 * MIN, used: false, result: null,
        resultExpires: null, step: null, pending: null, ipPrefix: ctx.ipPrefix };
      S.attempts.set(a.id, a);
      const op = oidc[p];
      const q = new URLSearchParams({ response_type: 'code', client_id: op.clientId, redirect_uri: op.redirectUri, scope: cfg.scopes.join(' '),
        state: a.state, nonce: a.nonce, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
      if (fresh) Object.keys(cfg.freshLogin).forEach((k) => q.set(k, cfg.freshLogin[k]));
      else if (cfg.prompt) q.set('prompt', cfg.prompt);
      ctx.setCookie(C.COOKIES.attemptLax, a.cookie);
      return { status: 200, body: { url: cfg.authorization + '?' + q.toString() } };
    },
    oauthCallback(ctx) {
      const p = ctx.params.provider; const q = ctx.query;
      const a = attemptFromCookie(ctx);
      if (!a || a.used || a.expiresAt <= now() || a.provider !== p || typeof q.state !== 'string' || !H.safeEqual(q.state, a.state)) return { status: 303 };
      a.used = true; a.resultExpires = now() + 5 * MIN;
      const cfg = provCfg(p);
      if (q.error) { a.result = { fail: PINS.mapError(p, q.error) }; return { status: 303 }; }
      if (cfg.callbackIss && q.iss !== cfg.issuers[0]) { a.result = { fail: 'provider' }; return { status: 303 }; }
      const t = now();
      S.prefixExchanges = S.prefixExchanges.filter((x) => t - x.at < 10 * MIN);
      if (S.prefixExchanges.filter((x) => x.prefix === ctx.ipPrefix).length >= 30) { a.result = { fail: 'provider' }; return { status: 303 }; }
      S.prefixExchanges.push({ at: t, prefix: ctx.ipPrefix });
      const op = oidc[p];
      const r = op.token({ grant_type: 'authorization_code', code: q.code, client_id: op.clientId, client_secret: op.clientSecret, redirect_uri: op.redirectUri, code_verifier: a.verifier });
      noteExchange(p, r.status >= 500);
      if (r.status !== 200) { a.result = { fail: r.status >= 500 ? 'provider' : 'token' }; return { status: 303 }; }
      a.result = checkIdToken(p, r.json.id_token, a);
      return { status: 303 };
    },
    oauthFinish(ctx) {
      const a = attemptFromCookie(ctx);
      if (!a || !a.used || !a.result || now() > a.resultExpires || now() > a.createdAt + 30 * MIN) { if (a) endAttempt(ctx, a); fail('oauth_state'); }
      if (a.result.fail) { endAttempt(ctx, a); fail('oauth_failed', { reason: a.result.fail }); }
      if (a.purpose === 'link') {
        const sid = ctx.cookies[C.COOKIES.session.name];
        if (!sid || sid !== a.boundSid || !S.sessions.get(sid)) { endAttempt(ctx, a); fail('oauth_state'); }
      }
      const b = ctx.body; const r = a.result; const p = a.provider;
      // later steps
      if (b.email !== undefined) {
        if (a.step !== 'email') fail('oauth_state');
        const e = V.normEmail(b.email);
        a.pending = { email: e, reason: 'verify' };
        const c = issueCode(e, 'oauth_verify', { attempt: a.id }, 'code_oauth_verify', { provider: p });
        return stepTo(ctx, a, 'code', { emailMasked: V.maskEmail(e), reason: 'verify' }, c.expires);
      }
      if (b.code !== undefined) {
        if (a.step !== 'code') fail('oauth_state');
        const purpose = a.pending.reason === 'link_confirm' ? 'link_confirm' : 'oauth_verify';
        const hit = takeCode((c) => c.boundAttempt === a.id && c.purpose === purpose, V.normCode(b.code));
        if (!hit) fail('invalid_or_expired');
        if (a.pending.reason === 'link_confirm') {
          const u = userOf(a.boundUser);
          if (identityList(u.id).some((i) => i.provider === p)) { endAttempt(ctx, a); fail('provider_linked'); }
          const i = linkIdentity(u, a, 'account_page');
          endAttempt(ctx, a);
          return { status: 200, body: { next: 'done', linked: methodsOf(u).identities.find((x) => x.id === i.id) } };
        }
        const acc = findAccount(a.pending.email);
        if (a.pending.reason === 'cancel_deletion') {
          const u = userOf(a.pending.userId);
          return providerSignIn(ctx, a, u, identityBySub(p, r.sub) || linkIdentity(u, a, 'code_confirm'), { stepup: true });
        }
        if (acc) {
          const u = acc.user;
          if (u.status === 'locked') { endAttempt(ctx, a); fail('locked'); }
          if (identityList(u.id).some((i) => i.provider === p)) { endAttempt(ctx, a); fail('provider_linked'); }
          return providerSignIn(ctx, a, u, linkIdentity(u, a, 'code_confirm'), { stepup: true });
        }
        const why = signupAllowed(a.pending.email);
        if (why) { endAttempt(ctx, a); fail(why); }
        if (providerState(p) === 'signin') { endAttempt(ctx, a); fail('provider_off', { provider: p }); }
        a.pending.proved = true;
        return stepTo(ctx, a, 'consent', { newAccountEmailMasked: V.maskEmail(a.pending.email), terms: config.terms, privacy: config.privacy });
      }
      if (b.consent !== undefined) {
        if (a.step !== 'consent') fail('oauth_state');
        if (!consentOk(b.consent)) fail('consent_required', { terms: config.terms, privacy: config.privacy });
        if (findAccount(a.pending.email)) { endAttempt(ctx, a); fail('oauth_state'); }
        const u = createUser(a.pending.email, p);
        if (b.profile) u.profile = profileOf(b.profile);
        return providerSignIn(ctx, a, u, linkIdentity(u, a, 'signup'), { stepup: !!a.pending.proved, first: true });
      }
      if (a.step) fail('oauth_state');
      // first call: the linking rules of §4.12
      const known = identityBySub(p, r.sub);
      if (a.purpose === 'link') {
        if (known) { endAttempt(ctx, a); if (known.userId === a.boundUser) return { status: 200, body: { next: 'done', linked: methodsOf(userOf(known.userId)).identities.find((x) => x.id === known.id) } }; fail('identity_in_use'); }
        const u = userOf(a.boundUser);
        if (identityList(u.id).some((i) => i.provider === p)) { endAttempt(ctx, a); fail('provider_linked'); }
        a.pending = { email: u.email, reason: 'link_confirm' };
        const c = issueCode(u.email, 'link_confirm', { attempt: a.id, user: u.id, sid: a.boundSid }, 'code_link_confirm',
          { provider: p, providerEmailMasked: r.email ? V.maskEmail(r.email) : '(none)' });
        return stepTo(ctx, a, 'code', { emailMasked: V.maskEmail(u.email), reason: 'link_confirm' }, c.expires);
      }
      if (known) {
        const u = userOf(known.userId);
        const g = statusGate(ctx, a, u); if (g) return g;
        return providerSignIn(ctx, a, u, known, { stepup: false });
      }
      if (trusted(p, r)) {
        const acc = findAccount(r.email);
        if (acc) {
          const g = statusGate(ctx, a, acc.user); if (g) return g;
          a.pending = { email: r.email, reason: 'link_existing' };
          const c = issueCode(r.email, 'oauth_verify', { attempt: a.id }, 'code_oauth_verify', { provider: p });
          return stepTo(ctx, a, 'code', { emailMasked: V.maskEmail(r.email), reason: 'link_existing' }, c.expires);
        }
        if (providerState(p) === 'signin') { endAttempt(ctx, a); fail('provider_off', { provider: p }); }
        const why = signupAllowed(r.email);
        if (why) { endAttempt(ctx, a); fail(why); }
        a.pending = { email: r.email, reason: 'signup', proved: false };
        return stepTo(ctx, a, 'consent', { newAccountEmailMasked: V.maskEmail(r.email), terms: config.terms, privacy: config.privacy });
      }
      const reason = !r.email ? 'missing' : (!r.emailVerified ? 'unverified' : 'unmanaged');
      return stepTo(ctx, a, 'email', { reason, emailPrefill: r.email || null });
    },
    methods(ctx) { const { u } = sessionOf(ctx); return { status: 200, body: methodsOf(u) }; },
    unlink(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      const i = S.identities.get(ctx.body.id);
      if (!i || i.userId !== u.id) fail('not_found');
      const n = removeIdentity(i);
      send(u.email, 'notice_identity_unlinked', { provider: i.provider });
      return { status: 200, body: { ok: true, methods: methodsOf(u), sessionsRevoked: n } };
    },
    me(ctx) {
      const { s, u } = sessionOf(ctx);
      const user = { id: u.id, emailMasked: V.maskEmail(u.email), created: u.created, status: u.status, terms: u.terms, privacy: u.privacy };
      if (u.recovery) user.recoveryMasked = V.maskEmail(u.recovery);
      if (u.deleteAt) user.deleteAt = iso(u.deleteAt);
      return { status: 200, body: {
        user,
        session: { publicDevice: s.publicDevice, authAt: iso(s.authAt), authMethod: s.authMethod, stepupAt: s.stepupAt ? iso(s.stepupAt) : null, idleExpires: iso(s.idleExp), absExpires: iso(s.absExp) },
        quota: { limit: u.quota, used: usedBytes(u.id) }, opts: Object.assign({}, u.opts),
        projects: Array.from(S.projects.values()).filter((p) => p.userId === u.id && !p.trashed && !p.purged).length,
        passkeys: [], identities: identityList(u.id).map((i) => ({ id: i.id, provider: i.provider, linkedAt: i.linkedAt, lastUsedAt: i.lastUsedAt })),
        devices: Array.from(S.devices.values()).filter((d) => d.userId === u.id && !d.revoked).map((d) => ({ id: d.id, label: d.label, lastSeen: d.lastSeen, current: d.id === s.deviceId })),
        minClient: config.minClient,
        profile: profileOf(null, u.profile),   // like the server: always an object, every field null when none was given
        countryHint: u.countryHint || null,    // the profile's country default (server: the connection's, else the last recorded)
      } };
    },
    outboxKey(ctx) { const { u } = sessionOf(ctx); return { status: 200, body: { k: u.outboxKey } }; },
    opts(ctx) { const { u } = sessionOf(ctx); ['historian', 'liveCfg'].forEach((k) => { if (ctx.body[k] !== undefined) u.opts[k] = ctx.body[k]; }); return { status: 200, body: { opts: Object.assign({}, u.opts) } }; },
    deviceRename(ctx) { const { u } = sessionOf(ctx); const d = S.devices.get(u.id + '|' + ctx.body.id); if (!d || d.revoked) fail('not_found'); d.label = ctx.body.label; return { status: 200, body: { ok: true } }; },
    deviceRevoke(ctx) {
      const { u } = sessionOf(ctx); const d = S.devices.get(u.id + '|' + ctx.body.id);
      if (!d || d.revoked) fail('not_found');
      d.revoked = true; revokeWhere((x) => x.userId === u.id && x.deviceId === d.id); send(u.email, 'notice_device_revoked');
      return { status: 200, body: { ok: true } };
    },
    library(ctx) { const { u } = sessionOf(ctx); syncGate(false); return { status: 200, body: { rev: u.lib.rev, hash: u.lib.hash, savedAt: u.lib.savedAt } }; },
    libraryBody(ctx) { const { u } = sessionOf(ctx); syncGate(false); if (!u.lib.body) fail('not_found'); return { status: 200, body: Buffer.from(u.lib.body) }; },
    libraryCommit(ctx) {
      const { u } = sessionOf(ctx); syncGate(true); notDeleting(u);
      const b = ctx.body;
      const done = S.receipts.get(u.id + '|' + b.pushId); if (done) return { status: 200, body: done };
      if (b.baseRev !== u.lib.rev) fail('stale', { rev: u.lib.rev, hash: u.lib.hash });
      u.lib = { rev: u.lib.rev + 1, hash: b.hash, savedAt: iso(), body: Buffer.from(b.body, 'base64') };
      const res = { rev: u.lib.rev }; S.receipts.set(u.id + '|' + b.pushId, res);
      return { status: 200, body: res };
    },
    projectList(ctx) {
      const { u } = sessionOf(ctx); syncGate(false); notDeleting(u);
      const trash = ctx.query.trash === '1';
      return { status: 200, body: Array.from(S.projects.values()).filter((p) => p.userId === u.id && !p.purged && !!p.trashed === trash).map(listItem) };
    },
    projectCreate(ctx) {
      const { u } = sessionOf(ctx); syncGate(true); notDeleting(u);
      if (Array.from(S.projects.values()).filter((p) => p.userId === u.id && !p.purged).length >= 200) fail('quota', { limit: 200, used: 200 });
      const p = { id: uuid(), userId: u.id, name: ctx.body.name, meta: ctx.body.meta, wells: 0, revs: [], trashed: null, purged: false, conflictOf: null, created: iso() };
      S.projects.set(p.id, p);
      return { status: 201, body: { id: p.id, headRev: 0 } };
    },
    projectHead(ctx) { const { u } = sessionOf(ctx); syncGate(false); notDeleting(u); const p = projectOf(u, ctx.params.id); return { status: 200, body: headBody(p, headOf(p)) }; },
    projectRevs(ctx) {
      const { u } = sessionOf(ctx); syncGate(false); notDeleting(u); const p = projectOf(u, ctx.params.id);
      const lim = Math.max(1, Math.min(200, Number(ctx.query.limit) || 50));
      return { status: 200, body: p.revs.slice().reverse().slice(0, lim).map((r) => ({ rev: r.rev, savedAt: r.savedAt, device: r.device, reason: r.reason, bytes: r.bytes, coreHash: r.coreHash })) };
    },
    projectRev(ctx) {
      const { u } = sessionOf(ctx); syncGate(false); notDeleting(u); const p = projectOf(u, ctx.params.id);
      const r = p.revs.find((x) => String(x.rev) === ctx.params.rev); if (!r) fail('not_found');
      return { status: 200, body: headBody(p, r) };
    },
    projectCommit(ctx) {
      const { s, u } = sessionOf(ctx); syncGate(true); notDeleting(u);
      const p = projectOf(u, ctx.params.id); const b = ctx.body;
      const rk = u.id + '|' + b.pushId;
      if (S.receipts.has(rk)) return { status: 200, body: S.receipts.get(rk) };
      const head = headOf(p); const headRev = head ? head.rev : 0;
      if (b.baseRev !== headRev) fail('stale', { headRev, head: headBody(p, head) });
      if (head && head.vhash === b.core.vhash && b.reason === 'auto') return { status: 200, body: { rev: head.rev, savedAt: head.savedAt } };
      if (b.core.inline !== undefined) {
        const z = Buffer.from(b.core.inline, 'base64');
        if (z.length > 48 * 1024 || sha(z) !== b.core.zsha) fail('bad_request', { field: 'core' });
        const k = blobKey(u.id, b.core.hash);
        if (!S.blobs.has(k)) S.blobs.set(k, { userId: u.id, hash: b.core.hash, zsha: b.core.zsha, of: 1, chunks: [z], complete: true, zbytes: z.length, bytes: b.core.bytes });
      }
      const missing = [b.core.hash].concat(b.parts.map((x) => x.hash)).filter((h, i, all) => all.indexOf(h) === i && !blobComplete(u.id, h));
      if (missing.length) fail('missing_blobs', { missing });
      if (usedBytes(u.id) > u.quota) fail('quota', { limit: u.quota, used: usedBytes(u.id) });
      const bytes = b.parts.reduce((n, x) => n + x.bytes, b.core.bytes);
      const r = { rev: headRev + 1, savedAt: iso(), device: s.deviceId || null, coreHash: b.core.hash, vhash: b.core.vhash, parts: b.parts.map((x) => ({ name: x.name, hash: x.hash, bytes: x.bytes })), bytes, reason: b.reason };
      if (b.core.inline !== undefined) r.coreInline = b.core.inline;
      p.revs.push(r); p.meta = { client: b.meta.client, well: b.meta.well, field: b.meta.field, operator: b.meta.operator }; p.name = b.meta.name || p.name; p.wells = b.wells.length;
      if (b.summary) p.summary = JSON.parse(JSON.stringify(b.summary));   // user insight: the latest summary per project
      const res = { rev: r.rev, savedAt: r.savedAt }; S.receipts.set(rk, res);
      return { status: 200, body: res };
    },
    projectRename(ctx) { const { u } = sessionOf(ctx); syncGate(true); notDeleting(u); const p = projectOf(u, ctx.params.id); p.name = ctx.body.name; if (ctx.body.meta) p.meta = ctx.body.meta; return { status: 200, body: { ok: true } }; },
    projectTrash(ctx) { const { u } = sessionOf(ctx); syncGate(true); notDeleting(u); const p = projectOf(u, ctx.params.id); p.trashed = now(); return { status: 200, body: { ok: true } }; },
    projectRestore(ctx) { const { u } = sessionOf(ctx); syncGate(true); notDeleting(u); const p = projectOf(u, ctx.params.id, { trash: true }); p.trashed = null; return { status: 200, body: { ok: true } }; },
    projectPurge(ctx) { const { s, u } = sessionOf(ctx); needStepup(s); syncGate(true); const p = projectOf(u, ctx.params.id, { trash: true }); p.purged = true; return { status: 200, body: { ok: true } }; },
    projectRestoreRev(ctx) {
      const { s, u } = sessionOf(ctx); syncGate(true); notDeleting(u); const p = projectOf(u, ctx.params.id);
      const rk = u.id + '|' + ctx.body.pushId; if (S.receipts.has(rk)) return { status: 200, body: S.receipts.get(rk) };
      const src = p.revs.find((x) => x.rev === ctx.body.rev); if (!src) fail('not_found');
      const r = Object.assign({}, src, { rev: headOf(p).rev + 1, savedAt: iso(), device: s.deviceId || null, reason: 'restore' });
      p.revs.push(r); const res = { rev: r.rev }; S.receipts.set(rk, res);
      return { status: 200, body: res };
    },
    projectDuplicate(ctx) {
      const { u } = sessionOf(ctx); syncGate(true); notDeleting(u); const p = projectOf(u, ctx.params.id);
      const h = headOf(p);
      const q = { id: uuid(), userId: u.id, name: ctx.body.name, meta: Object.assign({}, p.meta), wells: p.wells, revs: h ? [Object.assign({}, h, { rev: 1, savedAt: iso() })] : [], trashed: null, purged: false, conflictOf: null, created: iso() };
      S.projects.set(q.id, q);
      return { status: 201, body: { id: q.id, headRev: q.revs.length ? 1 : 0 } };
    },
    blobsHas(ctx) { const { u } = sessionOf(ctx); syncGate(false); return { status: 200, body: { missing: ctx.body.hashes.filter((h) => !blobComplete(u.id, h)) } }; },
    blobPut(ctx) {
      const { u } = sessionOf(ctx); syncGate(true); notDeleting(u);
      const h = ctx.params.hash; const n = Number(ctx.params.n); const of = Number(ctx.query.of);
      const zsha = String(H.header(ctx.req, 'x-wts-zsha') || ''); const csha = String(H.header(ctx.req, 'x-wts-chunk-sha') || '');
      const chunk = ctx.raw || Buffer.alloc(0);
      if (!C.TYPES.hex64(h) || !Number.isInteger(n) || !Number.isInteger(of) || of < 1 || n < 0 || n >= of || !C.TYPES.hex64(zsha) || !C.TYPES.hex64(csha)) fail('bad_request');
      if (chunk.length > 4 * 1024 * 1024) fail('too_large', { limit: 4 * 1024 * 1024 });
      if (sha(chunk) !== csha) fail('bad_request', { field: 'chunk' });
      const k = blobKey(u.id, h);
      let bl = S.blobs.get(k);
      if (bl && bl.complete) { if (bl.chunks[n] && Buffer.compare(bl.chunks[n], chunk) === 0) return { status: 204 }; fail('immutable'); }
      if (!bl) { bl = { userId: u.id, hash: h, zsha, of, chunks: new Array(of), complete: false, zbytes: 0 }; S.blobs.set(k, bl); }
      if (bl.chunks[n]) { if (Buffer.compare(bl.chunks[n], chunk) === 0) return { status: 204 }; fail('immutable'); }
      if (usedBytes(u.id) + chunk.length > u.quota) fail('quota', { limit: u.quota, used: usedBytes(u.id) });
      bl.chunks[n] = Buffer.from(chunk);
      if (bl.chunks.filter(Boolean).length === bl.of) {
        const all = Buffer.concat(bl.chunks);
        if (sha(all) === bl.zsha) { bl.complete = true; bl.zbytes = all.length; } else { S.blobs.delete(k); fail('bad_request', { field: 'zsha' }); }
      }
      return { status: 204 };
    },
    blobGet(ctx) {
      const { u } = sessionOf(ctx); syncGate(false);
      const bl = S.blobs.get(blobKey(u.id, ctx.params.hash)); const n = Number(ctx.params.n);
      if (!bl || !bl.complete || !bl.chunks[n]) fail('not_found');
      return { status: 200, body: Buffer.from(bl.chunks[n]), headers: { 'X-WTS-Of': String(bl.of), 'X-WTS-Zsha': bl.zsha } };
    },
    accountExport(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      send(u.email, 'notice_export');
      return { status: 200, body: {
        user: { id: u.id, email: u.email, recovery: u.recovery, created: u.created, status: u.status },
        consents: { terms: u.terms, privacy: u.privacy, at: u.consentedAt },
        devices: Array.from(S.devices.values()).filter((d) => d.userId === u.id).map((d) => ({ id: d.id, label: d.label, firstSeen: d.firstSeen, lastSeen: d.lastSeen })),
        passkeys: [],
        identities: identityList(u.id).map((i) => ({ provider: i.provider, subject: i.subject, email: i.email, emailVerifiedAtLink: i.emailVerifiedAtLink, linkedAt: i.linkedAt, lastUsedAt: i.lastUsedAt })),
        audit: S.audit.filter((a) => a.userId === u.id),
        projects: Array.from(S.projects.values()).filter((p) => p.userId === u.id && !p.purged).map((p) => ({ id: p.id, name: p.name, meta: p.meta, headRev: headOf(p) ? headOf(p).rev : 0,
          revs: p.revs.map((r) => ({ rev: r.rev, savedAt: r.savedAt, device: r.device, reason: r.reason, bytes: r.bytes, coreHash: r.coreHash })) })),
      } };
    },
    accountDelete(ctx) {
      const { s, u } = sessionOf(ctx); needStepup(s);
      u.status = 'deleting'; u.deleteAt = now() + (ctx.body.immediate ? 0 : 7 * DAY);
      identityList(u.id).forEach(removeIdentity);
      revokeWhere((x) => x.userId === u.id);
      ctx.setCookie(C.COOKIES.session, null);
      send(u.email, 'notice_delete_requested', { deleteAt: iso(u.deleteAt) });
      return { status: 200, body: { ok: true, deleteAt: iso(u.deleteAt) } };
    },
    profileUpdate(ctx) {
      const { u } = sessionOf(ctx); notDeleting(u);
      if (u.staleConsent) fail('consent_required', { terms: config.terms, privacy: config.privacy });
      u.profile = profileOf(ctx.body, u.profile);
      audit(u.id, 'profile', {});
      return { status: 200, body: { profile: Object.assign({}, u.profile) } };
    },
    accountDeleteCancel(ctx) {
      const { u } = sessionOf(ctx);
      if (u.status === 'deleting') { u.status = 'active'; u.deleteAt = null; send(u.email, 'notice_delete_cancelled'); }
      return { status: 200, body: { ok: true } };
    },
    cspReport: () => ({ status: 204 }),
    opsDaily: notImpl,
  };
  rebuild();

  // ── transport: a browser with a cookie jar (createBrowser below; shared with the end-to-end test's real server) ──────
  const T = { handle: (req) => app.handle(req), now, origin, oidc, requests, faults, ip: o.ip, latency: o.latency };
  function browser(name) { return createBrowser(T, name); }

  const main = browser('main');
  const fake = {
    fetch: main.fetch, navigate: main.navigate, visit: main.visit, jar: main.jar, cookie: main.cookie, restart: main.restart, browser,
    mail, oidc, state: S, requests,
    get config() { return config; },
    handle: (req) => app.handle(req),
    codeFor: (email, template) => mail.codeFor(V.normEmail(email), template),
    lastMail: (email) => mail.last(email && V.normEmail(email)),
    allow(email) { S.allow.add(V.normEmail(email)); },
    setSwitch(name, value) { if (value == null) delete env[name]; else env[name] = String(value); rebuild(); },
    fault(f) { faults.push(Object.assign({ path: '*', times: 1 }, f)); },
    clearFaults() { faults.length = 0; },
    user(email) { const a = findAccount(V.normEmail(email)); return a ? a.user : null; },
    sessionsOf(email) { const u = fake.user(email); return u ? Array.from(S.sessions.values()).filter((s) => s.userId === u.id) : []; },
    lock(email) { const u = fake.user(email); if (u) u.status = 'locked'; },
  };
  return fake;
}

// ── a browser with a cookie jar over a request handler ────────────────────────────────────────────────────────────
// createBrowser(T, name): T = {handle(req) → Promise<{status, headers, cookies, body}>, now, origin, oidc: {google, linkedin}
// (fake providers, for visit), requests?: [] (recorded), faults?: [] (fake.fault), ip?, latency?}. The fake server uses it with
// its in-memory handlers; server/test/e2e.test.js with the real core on a database.
function takeFault(faults, method, p) {
  for (let i = 0; i < faults.length; i++) {
    const f = faults[i];
    const pm = f.path === '*' || (f.path instanceof RegExp ? f.path.test(p) : p === f.path || p === C.BASE + f.path);
    if (pm && (!f.method || f.method === method)) { if (--f.times <= 0) faults.splice(i, 1); return f; }
  }
  return null;
}
function toBuffer(body) {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer || Object.prototype.toString.call(body) === '[object ArrayBuffer]') return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body) || (body && typeof body.byteLength === 'number' && body.buffer)) return Buffer.from(body.buffer, body.byteOffset || 0, body.byteLength);
  if (body && typeof body._text === 'string') return Buffer.from(body._text, 'utf8');      // harness Blob (text-only)
  return Buffer.from(String(body), 'utf8');
}
function makeResponse(out, url) {
  const headers = {};
  Object.keys(out.headers || {}).forEach((k) => { headers[k.toLowerCase()] = String(out.headers[k]); });
  const buf = out.body == null ? Buffer.alloc(0) : (Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body, 'utf8'));
  return {
    status: out.status, ok: out.status >= 200 && out.status < 300, statusText: String(out.status), url, redirected: false, type: 'basic',
    headers: { get: (n) => (headers[String(n).toLowerCase()] !== undefined ? headers[String(n).toLowerCase()] : null), has: (n) => headers[String(n).toLowerCase()] !== undefined, forEach: (fn) => Object.keys(headers).forEach((k) => fn(headers[k], k)) },
    json: () => Promise.resolve().then(() => JSON.parse(buf.toString('utf8'))),
    text: () => Promise.resolve(buf.toString('utf8')),
    arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    clone() { return makeResponse(out, url); },
  };
}
function delay(L, v) {
  if (!L || !L.ms) return Promise.resolve(v);
  return new Promise((res) => L.schedule(() => res(v), L.ms));
}
function createBrowser(T, name) {
  const now = T.now || (() => Date.now()); const origin = T.origin || PROD; const oidc = T.oidc || {};
  const jar = new Map();
  function applyCookies(list) {
    (list || []).forEach((line) => {
      const parts = line.split(';').map((s) => s.trim());
      const [k, ...rest] = parts[0].split('='); const v = rest.join('=');
      const attrs = {}; parts.slice(1).forEach((x) => { const [a, b2] = x.split('='); attrs[a.toLowerCase()] = b2 === undefined ? true : b2; });
      if (attrs['max-age'] === '0' || v === '') { jar.delete(k); return; }
      // no Max-Age = a browser-session cookie (persistent: false): gone after restart()
      jar.set(k, { value: v, sameSite: attrs.samesite || 'Lax', expires: attrs['max-age'] ? now() + Number(attrs['max-age']) * 1000 : null, persistent: !!attrs['max-age'], attrs });
    });
  }
  function cookieHeader(crossSiteNav) {
    const t = now(); const out = [];
    for (const [k, c] of jar) {
      if (c.expires && c.expires <= t) { jar.delete(k); continue; }
      if (crossSiteNav && c.sameSite === 'Strict') continue;
      out.push(k + '=' + c.value);
    }
    return out.join('; ');
  }
  async function raw(method, url, headers, body, crossSiteNav) {
    const u = new URL(url, origin);
    const p = u.pathname + u.search;
    const hdrs = { host: new URL(origin).host };
    Object.keys(headers || {}).forEach((k) => { hdrs[k.toLowerCase()] = String(headers[k]); });
    if (!crossSiteNav && method !== 'GET' && method !== 'HEAD') hdrs.origin = origin;
    const ck = cookieHeader(crossSiteNav); if (ck) hdrs.cookie = ck; else delete hdrs.cookie;
    const req = { method, url: p, headers: hdrs, body: toBuffer(body), remoteAddress: T.ip || '203.0.113.9' };
    if (T.requests) T.requests.push({ browser: name, method, path: u.pathname, query: u.search, at: now() });
    const f = T.faults ? takeFault(T.faults, method, u.pathname) : null;
    if (f && f.mode === 'network') throw new TypeError('Failed to fetch');
    let out;
    if (f && f.mode !== 'lost') {
      if (f.mode === 'server') out = { status: 500, headers: Object.assign({}, H.COMMON_HEADERS, { 'Content-Type': 'application/json' }), body: JSON.stringify({ error: 'server', message: 'Server error.' }), cookies: [] };
      else { const e = require(path.join(SRV, 'core', 'errors')).envelope(f.mode, f.extra || (f.mode === 'rate' ? { retryAfter: 30 } : {})); out = { status: e.status, headers: Object.assign({}, H.COMMON_HEADERS, { 'Content-Type': 'application/json' }), body: JSON.stringify(e.body), cookies: [] }; }
    } else out = await T.handle(req);
    applyCookies(out.cookies);
    if (f && f.mode === 'lost') throw new TypeError('Failed to fetch');
    return out;
  }
  const br = {
    name, jar,
    fetch(input, init) {
      init = init || {};
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String(init.method || 'GET').toUpperCase();
      let headers = init.headers || {};
      if (headers && typeof headers.forEach === 'function' && !Array.isArray(headers) && typeof headers.get === 'function') { const h2 = {}; headers.forEach((v, k) => { h2[k] = v; }); headers = h2; }
      return delay(T.latency).then(() => raw(method, url, headers, init.body, false)).then((out) => delay(T.latency, makeResponse(out, url)));
    },
    navigate(url) { return raw('GET', url, {}, null, true).then((out) => ({ status: out.status, location: out.headers && out.headers.Location })); },
    visit(url, v) {
      v = v || {};
      const u = new URL(url);
      const p = Object.keys(oidc).find((k) => u.origin + u.pathname === oidc[k].authorizationEndpoint);
      if (!p) throw new Error('fake: not a provider authorization URL: ' + url);
      const back = oidc[p].authorize(url, { user: v.as, cancel: v.cancel, error: v.error });
      return br.navigate(back);
    },
    cookie(name2) { const c = jar.get(name2); return c ? Object.assign({ name: name2 }, c) : null; },
    // a simulated browser restart: cookies without Max-Age (browser-session cookies) are dropped, expired ones too
    restart() { const t = now(); for (const [k, c] of jar) if (!c.persistent || (c.expires && c.expires <= t)) jar.delete(k); },
  };
  return br;
}

// A code sign-in through a browser of the fake, for tests that need a session (consent included for a new account).
async function signIn(fake, br, email, o) {
  o = o || {};
  const call = (p, body, extra) => br.fetch(PROD + C.BASE + p, { method: 'POST', headers: Object.assign({ 'X-WTS-Req': '1', 'Content-Type': 'application/json' }, extra || {}), body: JSON.stringify(body) });
  await call('/auth/code/start', { email, purpose: 'signin' });
  const code = fake.codeFor(email, 'code_signin');
  const body = { email, code, publicDevice: !!o.publicDevice };
  if (o.consent !== false) body.consent = { terms: fake.config.terms, privacy: fake.config.privacy };
  const r = await call('/auth/code/verify', body);
  return { status: r.status, json: await r.json() };
}

module.exports = { createFakeServer, createBrowser, prodLocation, signIn, PROD };
