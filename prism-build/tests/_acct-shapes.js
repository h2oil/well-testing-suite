'use strict';
// prism-build/tests/_acct-shapes.js — the accounts executable contract for client and server tests (docs/ACCOUNTS-PLAN.md §3,
// §5.2, §12). FROZEN with server/core/contract.js: changes only through the lead, together with the plan.
//
// Re-exports server/core/contract.js (ENDPOINTS, ERRORS, SHAPES, COOKIES, PROVIDERS, checkShape, checkError, matchRoute) and adds:
//   EXAMPLES            {endpointId: {req?, res: {status: body}}} — one valid request and one valid response per endpoint
//   ERROR_EXAMPLES      {code: envelope} — one valid envelope per error code
//   checkResponse(id, status, body) → {ok, errors}  the response shape of that endpoint and status (an error envelope for ≥ 400)
//   CANON_VECTORS       [{value, canonical, sha256}] — the canonical JSON reference vectors (server/core/canon.js; the client
//                       snapshot in 67 must give the same strings and hashes)
//   CLIENT_NAMES        the public names files 66–68 export (§5.2), per file
//   CLIENT_STATES       WTS_account.state().status values; SYNC_STATES — WTS_cloudSync.status().state values
//   EVENTS              the document events of §5.2
//   KEYS                the client storage names of §5.3
//   FAKE                require('./_acct-fake-server') (lazy)
//   server server/ paths: SERVER_DIR

const path = require('path');
const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const C = require(path.join(SERVER_DIR, 'core', 'contract'));
const { canonical, hashOf } = require(path.join(SERVER_DIR, 'core', 'canon'));

const T0 = '2026-11-08T12:00:00.000Z';
const T1 = '2026-12-13T12:00:00.000Z';
const U1 = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const D1 = '0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9';
const P1 = '11111111-2222-4333-8444-555555555555';
const I1 = '99999999-8888-4777-8666-555555555555';
const H1 = 'a'.repeat(64); const H2 = 'b'.repeat(64); const H3 = 'c'.repeat(64);
const MASK = 'n•••@company.example';
const META = { client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' };
const userBrief = { id: U1, emailMasked: MASK, created: T0 };
const signIn = { user: userBrief, firstSignIn: false, device: { id: D1, label: 'Office PC' }, session: { publicDevice: false, idleExpires: T1, absExpires: T1 } };
const methods = { email: { masked: MASK }, identities: [{ id: I1, provider: 'google', emailMasked: 'x•••@personal.example', linkedAt: T0, lastUsedAt: null }], passkeys: [] };
const head = { rev: 41, savedAt: T0, device: D1, coreHash: H1, vhash: H2, parts: [{ name: 'well/w1', hash: H3, bytes: 61230 }], bytes: 109443 };
const revItem = { rev: 41, savedAt: T0, device: D1, reason: 'save', bytes: 109443, coreHash: H1 };
const commitReq = {
  pushId: '6f1c2a3b-0000-4000-8000-000000000001', baseRev: 41, reason: 'auto',
  core: { hash: H1, vhash: H2, zsha: H3, bytes: 48213, inline: 'H4sIAAAAAAAAA6uuBQBDv6ajAgAAAA==' },
  parts: [{ name: 'well/w1', hash: H3, bytes: 61230 }, { name: 'well/w1/prism_gauges', hash: H2, bytes: 9120344 }],
  meta: { name: 'Example-1 DST', client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' },
  wells: [{ id: 'w1', name: 'Example-1' }], fmt: 2, appVer: '3.5',
};

const EXAMPLES = {
  codeStart: { req: { email: 'name@company.example', purpose: 'signin' }, res: { 202: { ok: true } } },
  codeVerify: { req: { email: 'name@company.example', code: '1234 5678', publicDevice: false, consent: { terms: '1', privacy: '1' } }, res: { 200: signIn } },
  emailChange: { req: { newEmail: 'new@company.example' }, res: { 202: { ok: true } } },
  emailConfirm: { req: { code: '12345678' }, res: { 200: { emailMasked: MASK } } },
  emailRevert: { req: { email: 'name@company.example', code: '12345678' }, res: { 200: { ok: true, sessions: 2, passkeysRemoved: 0, identitiesRemoved: 1 } } },
  recoverySet: { req: { email: 'me@personal.example' }, res: { 202: { ok: true }, 200: { ok: true } } },
  recoveryRemove: { req: {}, res: { 200: { ok: true } } },
  passkeyOptions: { req: { purpose: 'signin' }, res: { 200: { publicKey: { challenge: 'AAAA', rpId: 'welltest.h2oil.co.uk', userVerification: 'required', allowCredentials: [] } } } },
  passkeyVerify: { req: { credential: {}, publicDevice: false }, res: { 200: signIn } },
  passkeyRegisterOptions: { req: {}, res: { 200: { publicKey: {} } } },
  passkeyRegisterVerify: { req: { credential: {}, name: 'Laptop' }, res: { 201: { id: I1, name: 'Laptop', created: T0 } } },
  passkeyRename: { req: { id: I1, name: 'Laptop 2' }, res: { 200: { ok: true } } },
  passkeyRemove: { req: { id: I1 }, res: { 200: { ok: true } } },
  signOut: { req: {}, res: { 200: { ok: true } } },
  signOutAll: { req: { alsoRecentMethodsDays: 14 }, res: { 200: { ok: true, sessions: 3, passkeysRemoved: 0, identitiesRemoved: 0 } } },
  providers: { res: { 200: { google: 'on', linkedin: 'signin' } } },
  oauthStart: { req: { purpose: 'signin', publicDevice: false }, res: { 200: { url: 'https://google.idp.test/authorize?response_type=code' } } },
  oauthCallback: { res: { 303: null } },
  oauthFinish: { req: {}, res: { 200: { next: 'done', user: userBrief, firstSignIn: false, device: signIn.device, session: signIn.session, method: 'google', providerEmailDiffers: false } } },
  methods: { res: { 200: methods } },
  unlink: { req: { id: I1 }, res: { 200: { ok: true, methods, sessionsRevoked: 1 } } },
  me: { res: { 200: {
    user: { id: U1, emailMasked: MASK, created: T0, status: 'active', terms: '1', privacy: '1' },
    session: { publicDevice: false, authAt: T0, authMethod: 'google', stepupAt: null, idleExpires: T1, absExpires: T1 },
    quota: { limit: 250000000, used: 1200 }, opts: { historian: false, liveCfg: false }, projects: 1, passkeys: [],
    identities: [{ id: I1, provider: 'google', linkedAt: T0, lastUsedAt: T0 }], devices: [{ id: D1, label: 'Office PC', lastSeen: T0, current: true }], minClient: '3.5',
  } } },
  outboxKey: { res: { 200: { k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } } },
  opts: { req: { historian: true }, res: { 200: { opts: { historian: true, liveCfg: false } } } },
  deviceRename: { req: { id: D1, label: 'Rig laptop' }, res: { 200: { ok: true } } },
  deviceRevoke: { req: { id: D1 }, res: { 200: { ok: true } } },
  library: { res: { 200: { rev: 0, hash: null, savedAt: null } } },
  libraryBody: { res: { 200: null } },
  libraryCommit: { req: { pushId: commitReq.pushId, baseRev: 0, hash: H1, body: 'H4sIAAAAAAAAA6uuBQBDv6ajAgAAAA==' }, res: { 200: { rev: 1 } } },
  projectList: { res: { 200: [{ id: P1, name: 'Example-1 DST', meta: META, wells: 1, headRev: 41, savedAt: T0, savedBy: { device: D1 }, bytes: 109443 }] } },
  projectCreate: { req: { name: 'Example-1 DST', meta: META }, res: { 201: { id: P1, headRev: 0 } } },
  projectHead: { res: { 200: head } },
  projectRevs: { res: { 200: [revItem] } },
  projectRev: { res: { 200: head } },
  projectCommit: { req: commitReq, res: { 200: { rev: 42, savedAt: T0 } } },
  projectRename: { req: { name: 'Example-1 DST (final)' }, res: { 200: { ok: true } } },
  projectTrash: { req: {}, res: { 200: { ok: true } } },
  projectRestore: { req: {}, res: { 200: { ok: true } } },
  projectPurge: { req: {}, res: { 200: { ok: true } } },
  projectRestoreRev: { req: { rev: 40, pushId: commitReq.pushId }, res: { 200: { rev: 42 } } },
  projectDuplicate: { req: { name: 'Copy of Example-1 DST' }, res: { 201: { id: P1, headRev: 1 } } },
  blobsHas: { req: { hashes: [H1, H2] }, res: { 200: { missing: [H2] } } },
  blobPut: { res: { 204: null } },
  blobGet: { res: { 200: null } },
  accountExport: { req: {}, res: { 200: { user: {}, consents: {}, devices: [], passkeys: [], identities: [{ provider: 'linkedin', subject: 'abc123', email: 'name@company.example', emailVerifiedAtLink: false, linkedAt: T0, lastUsedAt: null }], audit: [], projects: [{ id: P1, name: 'Example-1 DST', meta: META, headRev: 41, revs: [revItem] }] } } },
  accountDelete: { req: { confirm: 'DELETE' }, res: { 200: { ok: true, deleteAt: T1 } } },
  accountDeleteCancel: { req: {}, res: { 200: { ok: true } } },
  health: { res: { 200: { ok: true, db: true, ver: '1.0.0' } } },
  cspReport: { res: { 204: null } },
  opsDaily: { req: {}, res: { 200: { ok: true } } },
};
const FINISH_EXAMPLES = [
  EXAMPLES.oauthFinish.res[200],
  { next: 'done', linked: methods.identities[0] },
  { next: 'email', reason: 'unmanaged', emailPrefill: 'name@company.example' },
  { next: 'code', emailMasked: MASK, reason: 'link_existing' },
  { next: 'consent', newAccountEmailMasked: 'x•••@personal.example' },
];
const ERROR_EXTRA = { bad_request: { field: 'email' }, oauth_failed: { reason: 'cancelled' }, stale: { headRev: 42, head },
  consent_required: { terms: '1', privacy: '1' }, too_large: { limit: 65536 }, quota: { limit: 250000000, used: 250000001 },
  missing_blobs: { missing: [H2] }, rate: { retryAfter: 30 }, provider_off: { provider: 'linkedin' } };
const ERROR_EXAMPLES = {};
Object.keys(C.ERRORS).forEach((code) => { ERROR_EXAMPLES[code] = Object.assign({ error: code, message: C.ERRORS[code].text }, ERROR_EXTRA[code] || {}); });

function checkResponse(id, status, body) {
  const ep = C.ENDPOINTS.find((e) => e.id === id);
  if (!ep) return { ok: false, errors: ['(root): unknown endpoint ' + id] };
  if (status >= 400) {
    const code = body && body.error;
    const errs = [];
    if (!C.ERRORS[code]) errs.push('error: unknown code ' + JSON.stringify(code));
    else {
      if (C.ERRORS[code].status !== status) errs.push('error: ' + code + ' is sent with ' + C.ERRORS[code].status + ', got ' + status);
      if (ep.errors.indexOf(code) === -1 && C.FOUNDATION_ONLY.indexOf(code) === -1) errs.push('error: ' + code + ' is not listed for ' + id);
      errs.push(...C.checkError(code, body).errors);
    }
    return { ok: errs.length === 0, errors: errs };
  }
  if (!Object.prototype.hasOwnProperty.call(ep.res, status)) return { ok: false, errors: ['(root): status ' + status + ' is not a ' + id + ' response'] };
  const shape = ep.res[status];
  if (shape === null) return { ok: body === null || body === undefined || Buffer.isBuffer(body) || typeof body === 'string', errors: [] };
  return C.checkShape(shape, body);
}

const CANON_VECTORS = [
  { b: 2, a: 1, c: [3, { z: null, y: 'é' }], d: undefined },
  { 'wts_page_choke': '{"v":1,"f":{"bean":"24"}}', wts_wells: '[]', n: -0.5, e: 1e21, t: true },
  [],
  'Operator Energy Ltd',
].map((value) => ({ value, canonical: canonical(value), sha256: hashOf(value) }));

const CLIENT_NAMES = {
  '66-account.js': { global: 'WTS_account', always: ['eligible'],
    fns: ['configure', 'state', 'refresh', 'openSignIn', 'signOut', 'stepUp', 'changeEmail', 'setRecovery', 'addPasskey', 'removePasskey',
      'renamePasskey', 'providers', 'signInWith', 'finishProviderSignIn', 'methods', 'linkProvider', 'unlinkMethod', 'call', 'on', 'off', 'seam'],
    props: ['VERSION', 'Error', 'PROVIDERS'] },
  '67-cloud-sync.js': { global: 'WTS_cloudSync',
    fns: ['status', 'link', 'unlink', 'saveToCloud', 'openFromCloud', 'importFiles', 'syncNow', 'listProjects', 'history', 'restoreRevision',
      'conflicts', 'resolve', 'diff', 'snapshot', 'migrateLocal', 'wipeDevice', 'historianBackup', 'historianRestore', 'exportAll', 'canonical', 'sha256Hex'],
    props: ['VERSION'] },
  '68-account-page.js': { global: 'WTS_accountPage', fns: ['render', 'register'], props: ['VERSION', 'entry'] },
};
const CLIENT_STATES = ['signedOut', 'signingIn', 'signedIn', 'unavailable'];
const SYNC_STATES = ['off', 'idle', 'dirty', 'syncing', 'offline', 'unavailable', 'conflict', 'quota', 'paused', 'readonly', 'signedOut'];
const EVENTS = ['wts:account-changed', 'wts:sync-status', 'wts:sync-applied', 'wts:sync-conflict'];
const KEYS = { hint: 'wtsacct_hint', beta: 'wtspref_cloud_beta', cloudOpen: 'wtspref_cloud_open', shared: 'wtspref_shared_browser', idb: 'wts-sync' };

module.exports = Object.assign({}, C, {
  EXAMPLES, FINISH_EXAMPLES, ERROR_EXAMPLES, checkResponse, CANON_VECTORS, CLIENT_NAMES, CLIENT_STATES, SYNC_STATES, EVENTS, KEYS, SERVER_DIR,
  get FAKE() { return require('./_acct-fake-server'); },
});
