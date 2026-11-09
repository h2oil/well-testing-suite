'use strict';
// server/core/contract.js — the FROZEN API contract of docs/ACCOUNTS-PLAN.md §3 (v3.5 Phase 1 + the Phase 3 passkey routes).
//
// One machine-checkable description shared by the server (request validation, route table), the in-memory fake server
// (prism-build/tests/_acct-fake-server.js) and the client tests (prism-build/tests/_acct-shapes.js re-exports this module
// with examples). Pure, no dependencies, no I/O. Changes only through the lead, together with the plan's §3.
//
// Exports
//   ERRORS      { code: {status, extra:[field…], text} } — every `error` the API may send (§3.2 table + finish errors)
//   ENDPOINTS   [{id, method, path, group, auth, phase, req, res:{status: shape|null}, errors:[code…], body, notes}]
//               auth: 'none' | 'session' | 'stepup' | 'attempt' (the __Host-wts_oa cookie) | 'provider' (the cross-site
//               callback) | 'hmac' (ops-daily) | 'report' (csp-report). body: 'json' | 'octet' | 'none' | 'csp'.
//   SHAPES      shape specs by name (see "Spec language" below)
//   checkShape(name, value) → {ok, errors:['<path>: <reason>', …]}
//   checkError(code, value) → the error envelope check for one code (status-independent)
//   matchRoute(method, path) → {endpoint, params} | null   (path without the /api/v1 base and without the query)
//   BASE        '/api/v1'
//   COOKIES     the two cookie definitions of §4.13
//   PROVIDERS   ['google', 'linkedin']; SWITCH_VALUES for OAUTH_<P>
//   FOUNDATION_ONLY  ['not_implemented'] — sent only by the WP0 stubs (501), never by a released server
//
// Spec language
//   'str' any string · 'nestr' non-empty string ≤ 4096 · 'int' integer · 'uint' integer ≥ 0 · 'num' finite number ·
//   'bool' · 'iso' ISO-8601 timestamp string · 'uuid' · 'hex64' 64 lowercase hex (SHA-256) · 'b64' base64 text ·
//   'email' a plausible address ≤ 254 · 'masked' a masked address (contains '•' and '@') · 'label' a device label
//   (≤ 40 of letters, digits, space, -_.()) · 'code8' 8 digits (spaces allowed) · 'revertKey' 26 of A–Z / 2–7 (spaces, hyphens, any case) · 'null' · 'any'
//   'a|b' alternatives; a quoted token 'x' is a literal string; true / false literal booleans; #N a literal number.
//   Objects: plain {key: spec}; 'key?' optional. Arrays: [spec] or arr(spec, {min, max}). orNull(spec). oneOf(field, map).
//   A function (v, path, ctx) is a custom rule. A string naming a shape ('@Name') refers to it.
//   Extra keys are allowed in responses and refused in requests (`strict` shapes: names ending in 'Req').

const BASE = '/api/v1';
const PROVIDERS = ['google', 'linkedin'];
const SWITCH_VALUES = ['on', 'signin', 'off'];
const FOUNDATION_ONLY = ['not_implemented'];

// ── error codes (§3.2 table; finish errors §3.3) ───────────────────────────────────────────────────────────────────
const ERRORS = {
  bad_request:        { status: 400, extra: ['field?'], text: 'The request failed a schema check.' },
  invalid_or_expired: { status: 400, extra: [], text: 'That code is wrong or has expired.' },
  oauth_state:        { status: 400, extra: [], text: 'Sign-in was interrupted. Try again.' },
  oauth_failed:       { status: 400, extra: ['reason'], text: 'Sign-in with the provider did not complete.' },
  signed_out:         { status: 401, extra: [], text: 'You are signed out.' },
  origin:             { status: 403, extra: [], text: 'Request refused.' },
  reauth:             { status: 403, extra: [], text: 'Confirm it is you to continue.' },
  locked:             { status: 403, extra: [], text: 'This account is locked. Contact software@h2oil.co.uk.' },
  not_invited:        { status: 403, extra: [], text: 'The beta is invite-only.' },
  signup_closed:      { status: 403, extra: [], text: 'New accounts are not open right now.' },
  not_found:          { status: 404, extra: [], text: 'Not found.' },
  stale:              { status: 409, extra: ['headRev?', 'head?', 'rev?', 'hash?'], text: 'The cloud copy changed.' },
  consent_required:   { status: 409, extra: ['terms?', 'privacy?'], text: 'Accept the current Terms of Use and Privacy notice.' },
  immutable:          { status: 409, extra: [], text: 'That part is already stored.' },
  identity_in_use:    { status: 409, extra: [], text: 'That sign-in is linked to another account.' },
  provider_linked:    { status: 409, extra: [], text: 'The account already has a sign-in of that provider.' },
  last_method:        { status: 409, extra: [], text: 'That would leave no way to sign in.' },
  gone:               { status: 410, extra: [], text: 'This project is in the trash or was deleted.' },
  too_large:          { status: 413, extra: ['limit?'], text: 'Too large.' },
  quota:              { status: 413, extra: ['limit', 'used'], text: 'Storage full.' },
  missing_blobs:      { status: 422, extra: ['missing'], text: 'Some parts are not uploaded yet.' },
  upgrade:            { status: 426, extra: [], text: 'Reload to update the app.' },
  rate:               { status: 429, extra: ['retryAfter'], text: 'Too many requests. Try again later.' },
  not_implemented:    { status: 501, extra: [], text: 'Not built yet (foundation stub).' },
  provider_off:       { status: 503, extra: ['provider'], text: 'That sign-in is not available right now. Use the e-mail code.' },
  paused:             { status: 503, extra: [], text: 'Cloud sync is paused. Your work is saved on this device.' },
  readonly:           { status: 503, extra: [], text: 'The cloud is read-only right now.' },
};
const OAUTH_FAIL_REASONS = ['cancelled', 'expired', 'provider', 'token', 'reauth_stale'];
const COMMIT_REASONS = ['auto', 'save', 'migrate', 'conflict', 'restore', 'overwrite', 'import'];

const COOKIES = {
  // session: no lifetime in the definition ON PURPOSE — every Set-Cookie for it passes {maxAge} = whole seconds from now to
  // the session's abs_expires_at (public devices 7 days, trusted 180 days; D4), so a trusted device keeps its session across
  // browser restarts and offline days. serializeCookie(def, value, {maxAge}) / ctx.setCookie(def, value, {maxAge}).
  session: { name: '__Host-wts_sid', secure: true, httpOnly: true, sameSite: 'Strict', path: '/', maxAgeRequired: true },
  attemptLax: { name: '__Host-wts_oa', secure: true, httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600 },
  attemptStrict: { name: '__Host-wts_oa', secure: true, httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 1200 },
  challenge: { name: '__Host-wts_chal', secure: true, httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 300 },
};

// ── checker ─────────────────────────────────────────────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const TYPES = {
  str: (v) => typeof v === 'string',
  nestr: (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096,
  int: (v) => Number.isInteger(v),
  uint: (v) => Number.isInteger(v) && v >= 0,
  num: (v) => typeof v === 'number' && isFinite(v),
  bool: (v) => typeof v === 'boolean',
  iso: (v) => typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v)),
  uuid: (v) => typeof v === 'string' && UUID_RE.test(v),
  hex64: (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v),
  b64: (v) => typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0,
  email: (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim()),
  masked: (v) => typeof v === 'string' && v.indexOf('•') !== -1 && v.indexOf('@') > 0 && v.length <= 254,
  label: (v) => typeof v === 'string' && v.length <= 40 && /^[A-Za-z0-9 _.()-]*$/.test(v),
  code8: (v) => typeof v === 'string' && /^\d{8}$/.test(v.replace(/\s/g, '')),
  revertKey: (v) => typeof v === 'string' && v.length <= 64 && /^[A-Z2-7]{26}$/.test(v.replace(/[\s-]/g, '').toUpperCase()),
  null: (v) => v === null,
  any: (v) => v !== undefined,
};
function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
  if (typeof v === 'number') return String(v);
  return typeof v;
}
function join(p, k) { return p ? p + '.' + k : k; }
function err(ctx, p, msg) { if (ctx.errors.length < ctx.max) ctx.errors.push((p || '(root)') + ': ' + msg); }
const parseCache = new Map();
function parseAlt(spec) {
  if (parseCache.has(spec)) return parseCache.get(spec);
  const alts = spec.split('|').map((t) => t.trim()).map((t) => {
    if (/^'.*'$/.test(t)) return { lit: t.slice(1, -1) };
    if (t === 'true' || t === 'false') return { lit: t === 'true' };
    if (/^#-?\d+(\.\d+)?$/.test(t)) return { lit: Number(t.slice(1)) };
    if (t[0] === '@') return { ref: t.slice(1) };
    if (!TYPES[t]) throw new Error('contract: unknown type ' + t + ' in ' + spec);
    return { type: t };
  });
  parseCache.set(spec, alts);
  return alts;
}
function checkAlt(spec, v, p, ctx) {
  const alts = parseAlt(spec);
  for (const a of alts) {
    if ('lit' in a && v === a.lit) return;
    if (a.type && TYPES[a.type](v)) return;
  }
  const refs = alts.filter((a) => a.ref);
  for (const r of refs) {
    const sub = { errors: [], max: ctx.max, strict: ctx.strict };
    checkNamed(r.ref, v, p, sub);
    if (!sub.errors.length) return;
    if (refs.length === 1 && alts.length === 1) { sub.errors.forEach((e) => { if (ctx.errors.length < ctx.max) ctx.errors.push(e); }); return; }
  }
  err(ctx, p, 'expected ' + spec + ', got ' + describe(v));
}
function checkObj(spec, v, p, ctx) {
  if (!isObj(v)) return err(ctx, p, 'expected an object, got ' + describe(v));
  const known = new Set();
  for (const key of Object.keys(spec)) {
    const opt = key.endsWith('?');
    const name = opt ? key.slice(0, -1) : key;
    known.add(name);
    const val = Object.prototype.hasOwnProperty.call(v, name) ? v[name] : undefined;
    if (val === undefined) { if (!opt) err(ctx, join(p, name), 'missing'); continue; }
    check(spec[key], val, join(p, name), ctx);
  }
  if (ctx.strict) for (const k of Object.keys(v)) if (!known.has(k)) err(ctx, join(p, k), 'unexpected key');
}
function check(spec, v, p, ctx) {
  if (ctx.errors.length >= ctx.max) return;
  if (typeof spec === 'string') return checkAlt(spec, v, p, ctx);
  if (typeof spec === 'function') return spec(v, p, ctx);
  if (Array.isArray(spec)) return checkArr(spec[0], v, p, ctx, {});
  if (spec && spec.$arr) return checkArr(spec.$arr, v, p, ctx, spec.o || {});
  if (spec && spec.$orNull) { if (v === null) return; return check(spec.$orNull, v, p, ctx); }
  if (spec && spec.$oneOf) {
    if (!isObj(v)) return err(ctx, p, 'expected an object, got ' + describe(v));
    const tag = v[spec.$oneOf];
    if (!Object.prototype.hasOwnProperty.call(spec.map, tag)) {
      return err(ctx, join(p, spec.$oneOf), 'expected ' + Object.keys(spec.map).map((k) => "'" + k + "'").join('|') + ', got ' + describe(tag));
    }
    return check(spec.map[tag], v, p, ctx);
  }
  if (spec && spec.$all) { spec.$all.forEach((s) => check(s, v, p, ctx)); return; }
  if (spec && typeof spec === 'object') return checkObj(spec, v, p, ctx);
  throw new Error('contract: bad spec at ' + p);
}
function checkArr(item, v, p, ctx, o) {
  if (!Array.isArray(v)) return err(ctx, p, 'expected an array, got ' + describe(v));
  if (o.min != null && v.length < o.min) err(ctx, p, 'expected at least ' + o.min + ' items, got ' + v.length);
  if (o.max != null && v.length > o.max) err(ctx, p, 'expected at most ' + o.max + ' items, got ' + v.length);
  for (let i = 0; i < v.length && ctx.errors.length < ctx.max; i++) check(item, v[i], p + '[' + i + ']', ctx);
}
const SHAPES = {};
function checkNamed(name, v, p, ctx) {
  const spec = SHAPES[name];
  if (!spec) return err(ctx, p, 'unknown shape ' + name);
  const prev = ctx.strict;
  ctx.strict = /Req$/.test(name);
  check(spec, v, p, ctx);
  ctx.strict = prev;
}
function checkShape(name, value) {
  if (!SHAPES[name]) return { ok: false, errors: ['(root): unknown shape ' + name] };
  const ctx = { errors: [], max: 100, strict: false };
  checkNamed(name, value, '', ctx);
  return { ok: ctx.errors.length === 0, errors: ctx.errors };
}

// spec helpers
const arr = (item, o) => ({ $arr: item, o });
const orNull = (s) => ({ $orNull: s });
const oneOf = (field, map) => ({ $oneOf: field, map });
const all = (...s) => ({ $all: s });
const rule = (fn) => (v, p, ctx) => { if (!isObj(v)) return; const m = fn(v); if (m) err(ctx, p, m); };
const enumOf = (list) => list.map((x) => "'" + x + "'").join('|');

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────
const S = SHAPES;
S.Ok = { ok: 'true' };
S.Consent = { terms: 'nestr', privacy: 'nestr' };
S.UserBrief = { id: 'uuid', emailMasked: 'masked', created: 'iso' };
S.Device = { id: 'uuid', label: 'label' };
S.SessionBrief = { publicDevice: 'bool', idleExpires: 'iso', absExpires: 'iso' };
S.SignInResult = { user: '@UserBrief', firstSignIn: 'bool', device: '@Device', session: '@SessionBrief' };
S.Passkey = { id: 'uuid', name: 'str', created: 'iso', lastUsed: orNull('iso') };
S.IdentityBrief = { id: 'uuid', provider: enumOf(PROVIDERS), linkedAt: 'iso', lastUsedAt: orNull('iso') };
S.IdentityMethod = { id: 'uuid', provider: enumOf(PROVIDERS), emailMasked: orNull('masked'), linkedAt: 'iso', lastUsedAt: orNull('iso') };
S.Methods = { email: { masked: 'masked' }, 'recovery?': { masked: 'masked' }, identities: arr('@IdentityMethod', { max: 2 }), passkeys: arr('@Passkey', { max: 10 }) };
S.Providers = { google: enumOf(SWITCH_VALUES), linkedin: enumOf(SWITCH_VALUES) };
S.ErrorEnvelope = { error: 'nestr', message: 'str', 'retryAfter?': 'uint' };

// auth requests
// A step-up code goes to the session user's own address (the page knows only the masked form), so `email` may be left out
// for purpose 'stepup' (start) and for a step-up verify, which the server matches through the session (WP0 refinement of §3.3).
S.CodeStartReq = all({ 'email?': 'email', purpose: "'signin'|'stepup'|'email_change'|'recovery_add'", 'to?': "'primary'|'recovery'" },
  rule((v) => (v.email === undefined && v.purpose !== 'stepup') ? 'email: missing (required unless purpose is stepup)' : null));
S.CodeVerifyReq = { 'email?': 'email', code: 'code8', 'deviceLabel?': 'label', publicDevice: 'bool', 'consent?': '@Consent' };
S.EmailChangeReq = { newEmail: 'email' };
S.EmailConfirmReq = { code: 'code8' };
S.EmailRevertReq = { email: 'email', code: 'revertKey' };
S.RecoverySetReq = all({ 'email?': 'email', 'code?': 'code8' }, rule((v) => ((v.email !== undefined) === (v.code !== undefined)) ? 'expected exactly one of email | code' : null));
S.RecoveryRemoveReq = {};
S.PasskeyOptionsReq = { purpose: "'signin'|'stepup'" };
S.PasskeyVerifyReq = { credential: 'any', publicDevice: 'bool' };
S.PasskeyRegisterOptionsReq = {};
S.PasskeyRegisterVerifyReq = { credential: 'any', name: 'str' };
S.PasskeyRenameReq = { id: 'uuid', name: 'str' };
S.PasskeyRemoveReq = { id: 'uuid' };
S.SignOutReq = {};
S.SignOutAllReq = { 'alsoRecentMethodsDays?': 'uint' };
// sharedBrowser: the page's wtspref_shared_browser flag (T30) — with publicDevice it makes the attempt a fresh-login attempt
// (§4.10 item 3); the plan names the flag but not the field (WP0 refinement).
S.OAuthStartReq = { purpose: "'signin'|'link'", publicDevice: 'bool', 'sharedBrowser?': 'bool', 'deviceLabel?': 'label' };
S.OAuthFinishReq = all({ 'email?': 'email', 'code?': 'code8', 'consent?': '@Consent' },
  rule((v) => (['email', 'code', 'consent'].filter((k) => v[k] !== undefined).length > 1) ? 'expected at most one of email | code | consent' : null));
S.UnlinkReq = { id: 'uuid' };
// auth responses
S.EmailConfirmRes = { emailMasked: 'masked' };
S.RevokeRes = { ok: 'true', sessions: 'uint', passkeysRemoved: 'uint', identitiesRemoved: 'uint' };
S.PasskeyOptionsRes = { publicKey: { challenge: 'b64|str', rpId: "'welltest.h2oil.co.uk'", userVerification: "'required'", allowCredentials: arr('any') } };
S.PasskeyRegisterOptionsRes = { publicKey: 'any' };
S.PasskeyCreatedRes = { id: 'uuid', name: 'str', created: 'iso' };
S.OAuthStartRes = { url: (v, p, ctx) => { if (typeof v !== 'string' || !/^https?:\/\/[^\s]+$/.test(v)) err(ctx, p, 'expected an absolute http(s) URL, got ' + describe(v)); } };
S.FinishDone = { next: "'done'", user: '@UserBrief', firstSignIn: 'bool', device: '@Device', session: '@SessionBrief', method: enumOf(PROVIDERS), providerEmailDiffers: 'bool' };
S.FinishLinked = { next: "'done'", linked: '@IdentityMethod' };
S.FinishEmail = { next: "'email'", reason: "'missing'|'unverified'|'unmanaged'", 'emailPrefill?': orNull('email') };
S.FinishCode = { next: "'code'", emailMasked: 'masked', reason: "'verify'|'link_existing'|'link_confirm'|'cancel_deletion'" };
S.FinishConsent = { next: "'consent'", newAccountEmailMasked: 'masked', 'terms?': 'nestr', 'privacy?': 'nestr' };
S.FinishRes = oneOf('next', {
  done: (v, p, ctx) => checkNamed(v && v.linked !== undefined ? 'FinishLinked' : 'FinishDone', v, p, ctx),
  email: '@FinishEmail', code: '@FinishCode', consent: '@FinishConsent',
});
S.UnlinkRes = { ok: 'true', methods: '@Methods', sessionsRevoked: 'uint' };

// me, devices, library
S.Me = {
  user: { id: 'uuid', emailMasked: 'masked', 'recoveryMasked?': 'masked', created: 'iso', status: "'active'|'locked'|'deleting'", 'deleteAt?': 'iso', terms: 'nestr', privacy: 'nestr' },
  session: { publicDevice: 'bool', authAt: 'iso', authMethod: "'code'|'google'|'linkedin'|'passkey'", stepupAt: orNull('iso'), idleExpires: 'iso', absExpires: 'iso' },
  quota: { limit: 'uint', used: 'uint' },
  opts: { historian: 'bool', liveCfg: 'bool' },
  projects: 'uint',
  passkeys: arr('@Passkey', { max: 10 }),
  identities: arr('@IdentityBrief', { max: 2 }),
  devices: [{ id: 'uuid', label: 'label', lastSeen: orNull('iso'), current: 'bool' }],
  minClient: 'str',
};
S.OutboxKeyRes = { k: 'b64' };
S.OptsReq = { 'historian?': 'bool', 'liveCfg?': 'bool' };
S.OptsRes = { opts: { historian: 'bool', liveCfg: 'bool' } };
S.DeviceRenameReq = { id: 'uuid', label: 'label' };
S.DeviceRevokeReq = { id: 'uuid' };
S.LibraryHead = { rev: 'uint', hash: orNull('hex64'), savedAt: orNull('iso') };
S.LibraryCommitReq = { pushId: 'uuid', baseRev: 'uint', hash: 'hex64', body: (v, p, ctx) => { if (!TYPES.b64(v) || v.length > 2800000) err(ctx, p, 'expected base64 gzip ≤ 2 MB, got ' + describe(v)); } };
S.RevRes = { rev: 'uint' };

// projects
S.ProjectMeta = { client: 'str', well: 'str', field: 'str', operator: 'str' };
S.ProjectListItem = { id: 'uuid', name: 'str', meta: '@ProjectMeta', wells: 'uint', headRev: 'uint', savedAt: orNull('iso'), savedBy: { device: orNull('uuid') }, bytes: 'uint', 'conflictOf?': orNull('uuid') };
S.ProjectList = arr('@ProjectListItem', { max: 200 });
S.ProjectCreateReq = { name: (v, p, ctx) => { if (typeof v !== 'string' || !v.trim() || v.length > 200) err(ctx, p, 'expected a name of 1–200 characters, got ' + describe(v)); }, meta: '@ProjectMeta' };
S.ProjectCreated = { id: 'uuid', headRev: 'uint' };
S.Part = { name: (v, p, ctx) => { if (typeof v !== 'string' || !/^well\/[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_.-]{1,64})?$|^core$/.test(v)) err(ctx, p, "expected a part name 'well/<id>[/<name>]', got " + describe(v)); }, hash: 'hex64', bytes: 'uint' };
S.Head = { rev: 'uint', savedAt: orNull('iso'), device: orNull('uuid'), coreHash: orNull('hex64'), vhash: orNull('hex64'), parts: arr('@Part', { max: 2000 }), bytes: 'uint', 'coreInline?': 'b64' };
S.RevItem = { rev: 'uint', savedAt: 'iso', device: orNull('uuid'), reason: enumOf(COMMIT_REASONS), bytes: 'uint', coreHash: 'hex64' };
S.RevList = arr('@RevItem', { max: 200 });
S.CommitReq = {
  pushId: 'uuid', baseRev: 'uint', reason: enumOf(COMMIT_REASONS),
  core: { hash: 'hex64', vhash: 'hex64', zsha: 'hex64', bytes: 'uint', 'inline?': 'b64' },
  parts: arr('@Part', { max: 2000 }),
  meta: { name: 'str', client: 'str', well: 'str', field: 'str', operator: 'str' },
  wells: arr({ id: 'nestr', name: 'str' }, { max: 200 }),
  fmt: 'uint', appVer: 'str',
};
S.CommitRes = { rev: 'uint', savedAt: 'iso' };
S.RenameReq = { name: 'nestr', 'meta?': '@ProjectMeta' };
S.EmptyReq = {};
S.RestoreRevReq = { rev: 'uint', pushId: 'uuid' };
S.DuplicateReq = { name: 'nestr' };

// blobs
S.BlobsHasReq = { hashes: arr('hex64', { max: 200 }) };
S.BlobsHasRes = { missing: arr('hex64', { max: 200 }) };

// account
S.ExportRes = {
  user: 'any', consents: 'any', devices: arr('any'), passkeys: arr({ name: 'str', created: 'iso' }),
  identities: arr({ provider: enumOf(PROVIDERS), subject: 'nestr', email: orNull('str'), emailVerifiedAtLink: 'bool', linkedAt: 'iso', lastUsedAt: orNull('iso') }),
  audit: arr('any'), projects: arr({ id: 'uuid', name: 'str', meta: '@ProjectMeta', headRev: 'uint', revs: arr('@RevItem') }),
};
S.DeleteReq = { confirm: "'DELETE'", 'immediate?': 'bool' };
S.DeleteRes = { ok: 'true', deleteAt: 'iso' };
S.Health = { ok: 'bool', db: 'bool', ver: 'str' };
S.OpsDailyRes = { ok: 'true', 'did?': 'any' };

// ── endpoints (§3.3; '/api/v1' omitted) ─────────────────────────────────────────────────────────────────────────
const COMMON = ['bad_request', 'origin', 'rate', 'paused', 'upgrade'];
const SIGNED = COMMON.concat(['signed_out', 'locked', 'gone']);   // gone: the account is deleting (§3.2)
const E = [];
function ep(id, method, path, o) {
  E.push(Object.assign({ id, method, path, group: path.split('/')[1], auth: 'session', phase: 1, req: null, res: {}, errors: [], body: method === 'GET' ? 'none' : 'json', notes: '' }, o));
}
// auth
ep('codeStart', 'POST', '/auth/code/start', { auth: 'none', req: 'CodeStartReq', res: { 202: 'Ok' }, errors: COMMON, notes: 'always 202; queued mail; padded to a fixed floor' });
ep('codeVerify', 'POST', '/auth/code/verify', { auth: 'none', req: 'CodeVerifyReq', res: { 200: 'SignInResult' }, errors: COMMON.concat(['invalid_or_expired', 'consent_required', 'locked']), notes: 'sets __Host-wts_sid' });
ep('emailChange', 'POST', '/auth/email/change', { auth: 'stepup', req: 'EmailChangeReq', res: { 202: 'Ok' }, errors: SIGNED.concat(['reauth']) });
ep('emailConfirm', 'POST', '/auth/email/confirm', { req: 'EmailConfirmReq', res: { 200: 'EmailConfirmRes' }, errors: SIGNED.concat(['invalid_or_expired']) });
ep('emailRevert', 'POST', '/auth/email/revert', { auth: 'none', req: 'EmailRevertReq', res: { 200: 'RevokeRes' }, errors: COMMON.concat(['invalid_or_expired']), notes: 'sets a new __Host-wts_sid' });
ep('recoverySet', 'POST', '/auth/recovery/set', { auth: 'stepup', req: 'RecoverySetReq', res: { 200: 'Ok', 202: 'Ok' }, errors: SIGNED.concat(['reauth', 'invalid_or_expired']), notes: '{email} → 202 (code sent), then {code} → 200' });
ep('recoveryRemove', 'POST', '/auth/recovery/remove', { auth: 'stepup', req: 'RecoveryRemoveReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['reauth']) });
ep('passkeyOptions', 'POST', '/auth/passkey/options', { auth: 'none', phase: 3, req: 'PasskeyOptionsReq', res: { 200: 'PasskeyOptionsRes' }, errors: COMMON });
ep('passkeyVerify', 'POST', '/auth/passkey/verify', { auth: 'none', phase: 3, req: 'PasskeyVerifyReq', res: { 200: 'SignInResult' }, errors: COMMON.concat(['invalid_or_expired', 'locked']) });
ep('passkeyRegisterOptions', 'POST', '/auth/passkey/register/options', { auth: 'stepup', phase: 3, req: 'PasskeyRegisterOptionsReq', res: { 200: 'PasskeyRegisterOptionsRes' }, errors: SIGNED.concat(['reauth']) });
ep('passkeyRegisterVerify', 'POST', '/auth/passkey/register/verify', { phase: 3, req: 'PasskeyRegisterVerifyReq', res: { 201: 'PasskeyCreatedRes' }, errors: SIGNED.concat(['invalid_or_expired']) });
ep('passkeyRename', 'POST', '/auth/passkey/rename', { phase: 3, req: 'PasskeyRenameReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['not_found']) });
ep('passkeyRemove', 'POST', '/auth/passkey/remove', { auth: 'stepup', phase: 3, req: 'PasskeyRemoveReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['reauth', 'not_found', 'last_method']) });
ep('signOut', 'POST', '/auth/signout', { auth: 'none', req: 'SignOutReq', res: { 200: 'Ok' }, errors: COMMON, notes: 'clears __Host-wts_sid; works without a session' });
ep('signOutAll', 'POST', '/auth/signout-all', { auth: 'stepup', req: 'SignOutAllReq', res: { 200: 'RevokeRes' }, errors: SIGNED.concat(['reauth']) });
ep('providers', 'GET', '/auth/providers', { auth: 'none', res: { 200: 'Providers' }, errors: [], notes: 'no cookie read; no-store' });
ep('oauthStart', 'POST', '/auth/oauth/:provider/start', { auth: 'none', req: 'OAuthStartReq', res: { 200: 'OAuthStartRes' }, errors: COMMON.concat(['oauth_failed', 'provider_off', 'reauth', 'signed_out', 'not_found']), notes: "link needs a session with step-up; sets __Host-wts_oa (Lax, 600 s)" });
ep('oauthCallback', 'GET', '/auth/oauth/:provider/callback', { auth: 'provider', res: { 303: null }, errors: [], notes: 'always 303 to <APP_URL>#acct-oauth; reads only __Host-wts_oa' });
ep('oauthFinish', 'POST', '/auth/oauth/finish', { auth: 'attempt', req: 'OAuthFinishReq', res: { 200: 'FinishRes' }, errors: COMMON.concat(['oauth_state', 'oauth_failed', 'invalid_or_expired', 'locked', 'not_invited', 'signup_closed', 'identity_in_use', 'provider_linked', 'consent_required', 'provider_off']) });
ep('methods', 'GET', '/auth/methods', { res: { 200: 'Methods' }, errors: SIGNED });
ep('unlink', 'POST', '/auth/methods/unlink', { auth: 'stepup', req: 'UnlinkReq', res: { 200: 'UnlinkRes' }, errors: SIGNED.concat(['reauth', 'not_found', 'last_method']) });
// me, devices, library
ep('me', 'GET', '/me', { res: { 200: 'Me' }, errors: SIGNED });
ep('outboxKey', 'GET', '/me/outbox-key', { res: { 200: 'OutboxKeyRes' }, errors: SIGNED });
ep('opts', 'POST', '/me/opts', { req: 'OptsReq', res: { 200: 'OptsRes' }, errors: SIGNED });
ep('deviceRename', 'POST', '/devices/rename', { req: 'DeviceRenameReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['not_found']) });
ep('deviceRevoke', 'POST', '/devices/revoke', { req: 'DeviceRevokeReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['not_found']) });
ep('library', 'GET', '/library', { res: { 200: 'LibraryHead' }, errors: SIGNED });
ep('libraryBody', 'GET', '/library/body', { res: { 200: null }, errors: SIGNED.concat(['not_found']), notes: 'application/octet-stream (gzip JSON)' });
ep('libraryCommit', 'POST', '/library/commit', { req: 'LibraryCommitReq', res: { 200: 'RevRes' }, errors: SIGNED.concat(['stale', 'too_large', 'quota', 'readonly']) });
// projects
const PROJ = SIGNED.concat(['not_found', 'gone']);
ep('projectList', 'GET', '/projects', { res: { 200: 'ProjectList' }, errors: SIGNED, notes: '?trash=0|1' });
ep('projectCreate', 'POST', '/projects', { req: 'ProjectCreateReq', res: { 201: 'ProjectCreated' }, errors: SIGNED.concat(['too_large', 'quota', 'readonly']), notes: '≤ 200 projects' });
ep('projectHead', 'GET', '/projects/:id/head', { res: { 200: 'Head' }, errors: PROJ });
ep('projectRevs', 'GET', '/projects/:id/revs', { res: { 200: 'RevList' }, errors: PROJ, notes: '?limit=50' });
ep('projectRev', 'GET', '/projects/:id/rev/:rev', { res: { 200: 'Head' }, errors: PROJ });
ep('projectCommit', 'POST', '/projects/:id/commit', { req: 'CommitReq', res: { 200: 'CommitRes' }, errors: PROJ.concat(['stale', 'missing_blobs', 'too_large', 'quota', 'readonly']) });
ep('projectRename', 'POST', '/projects/:id/rename', { req: 'RenameReq', res: { 200: 'Ok' }, errors: PROJ.concat(['readonly']) });
ep('projectTrash', 'POST', '/projects/:id/trash', { req: 'EmptyReq', res: { 200: 'Ok' }, errors: PROJ.concat(['readonly']) });
ep('projectRestore', 'POST', '/projects/:id/restore', { req: 'EmptyReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['not_found', 'readonly']) });
ep('projectPurge', 'POST', '/projects/:id/purge', { auth: 'stepup', req: 'EmptyReq', res: { 200: 'Ok' }, errors: SIGNED.concat(['not_found', 'reauth', 'readonly']) });
ep('projectRestoreRev', 'POST', '/projects/:id/restore-rev', { req: 'RestoreRevReq', res: { 200: 'RevRes' }, errors: PROJ.concat(['readonly']) });
ep('projectDuplicate', 'POST', '/projects/:id/duplicate', { req: 'DuplicateReq', res: { 201: 'ProjectCreated' }, errors: PROJ.concat(['readonly', 'quota']) });
// blobs
ep('blobsHas', 'POST', '/blobs/has', { req: 'BlobsHasReq', res: { 200: 'BlobsHasRes' }, errors: SIGNED });
ep('blobPut', 'PUT', '/blobs/:hash/:n', { body: 'octet', res: { 204: null }, errors: SIGNED.concat(['immutable', 'too_large', 'quota', 'readonly']), notes: '?of=N; headers X-WTS-Zsha, X-WTS-Chunk-Sha; chunk ≤ 4 MB' });
ep('blobGet', 'GET', '/blobs/:hash/:n', { res: { 200: null }, errors: SIGNED.concat(['not_found']), notes: 'application/octet-stream; X-WTS-Of, X-WTS-Zsha' });
// account
ep('accountExport', 'POST', '/account/export', { auth: 'stepup', req: 'EmptyReq', res: { 200: 'ExportRes' }, errors: SIGNED.concat(['reauth']) });
ep('accountDelete', 'POST', '/account/delete', { auth: 'stepup', req: 'DeleteReq', res: { 200: 'DeleteRes' }, errors: SIGNED.concat(['reauth']) });
ep('accountDeleteCancel', 'POST', '/account/delete/cancel', { req: 'EmptyReq', res: { 200: 'Ok' }, errors: SIGNED });
ep('health', 'GET', '/health', { auth: 'none', res: { 200: 'Health' }, errors: [] });
ep('cspReport', 'POST', '/csp-report', { auth: 'report', body: 'csp', res: { 204: null }, errors: ['too_large', 'rate'] });
ep('opsDaily', 'POST', '/ops/daily', { auth: 'hmac', req: 'EmptyReq', res: { 200: 'OpsDailyRes' }, errors: ['origin'] });

const ENDPOINTS = E;
const ROUTES = E.map((e) => {
  const names = [];
  const re = new RegExp('^' + e.path.replace(/:([a-z]+)/g, (m, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { e, re, names };
});
function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.e.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    try { r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); }); } catch (e) { return null; }   // malformed escape → 404
    return { endpoint: r.e, params };
  }
  return null;
}
function pathExists(path) { return ROUTES.some((r) => r.re.test(path)); }
function checkError(code, value) {
  const def = ERRORS[code];
  if (!def) return { ok: false, errors: ['(root): unknown error code ' + code] };
  const res = checkShape('ErrorEnvelope', value);
  if (value && value.error !== code) res.errors.push('error: expected ' + JSON.stringify(code) + ', got ' + describe(value && value.error));
  for (const f of def.extra) {
    const opt = f.endsWith('?'); const n = opt ? f.slice(0, -1) : f;
    if (!opt && (!value || value[n] === undefined)) res.errors.push(n + ': missing');
  }
  if (code === 'oauth_failed' && value && OAUTH_FAIL_REASONS.indexOf(value.reason) === -1) res.errors.push('reason: expected ' + enumOf(OAUTH_FAIL_REASONS) + ', got ' + describe(value.reason));
  if (code === 'provider_off' && value && PROVIDERS.indexOf(value.provider) === -1) res.errors.push('provider: expected ' + enumOf(PROVIDERS));
  if (code === 'missing_blobs' && value && !(Array.isArray(value.missing) && value.missing.every(TYPES.hex64))) res.errors.push('missing: expected an array of hex64');
  if (code === 'rate' && value && !TYPES.uint(value.retryAfter)) res.errors.push('retryAfter: expected uint');
  res.ok = res.errors.length === 0;
  return res;
}

module.exports = {
  BASE, PROVIDERS, SWITCH_VALUES, FOUNDATION_ONLY, ERRORS, OAUTH_FAIL_REASONS, COMMIT_REASONS, COOKIES,
  SHAPES, ENDPOINTS, TYPES, checkShape, checkError, matchRoute, pathExists,
};
