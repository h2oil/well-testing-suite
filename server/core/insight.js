'use strict';
// server/core/insight.js — the optional account profile and the project summary (insight follow-up of the admin dashboard;
// privacy notice version 2, "Accounts"). Pure functions; the request shapes (core/contract.js ProfileReq / SummaryReq) have
// already been checked, these normalise what is stored and read it back.
//
//   normProfile(obj) → {fullName, company, jobTitle, country, phone} (every key present; text NFKC-normalised and trimmed,
//                      empty → null) — throws bad_request {field:'profile.<key>'} for anything the contract would refuse
//   isEmptyProfile(p) → true when every field is null (stored as NULL)
//   sealProfile(u, p) / openProfile(u, buf) → Buffer | null / profile | null   (envelope field 'user.profile', the user's key)
//   normSummary(obj)  → {name, client, operator, company, field, rig, country, jobRef, wells[], modules[]} (wells / modules:
//                      empty and repeated entries dropped, order kept)
//   sealSummary(u, s) / openSummary(u, buf) → (envelope field 'project.summary')
//   distinct(values, max) → unique non-empty text, case-insensitive (first spelling kept), at most max
//   top(values, max) → [{value, n}] counted case-insensitively, the most common spelling shown, most frequent first
//   storeProfile(unit, p, via, deviceId) — writes users.profile_enc for the unit's user and audits the field NAMES set
// Field-level opening for the admin routes, which hold no session of the account: openWith(keys, field, buf) over the
// account's opened key ring (E.openField), never thrown at the caller (null on any failure).

const { fail } = require('./errors');
const C = require('./contract');
const E = require('./envelope');

const PROFILE_FIELD = 'user.profile';
const SUMMARY_FIELD = 'project.summary';
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function text(v, max, field) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || CTRL.test(v)) fail('bad_request', { field });
  const n = v.normalize('NFKC').trim();
  if (n.length > max) fail('bad_request', { field });
  return n || null;
}
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function onlyKeys(o, keys, field) {
  if (!isObj(o)) fail('bad_request', { field });
  for (const k of Object.keys(o)) if (keys.indexOf(k) === -1) fail('bad_request', { field: field + '.' + k });
}

function normProfile(o) {
  onlyKeys(o, C.PROFILE_KEYS, 'profile');
  const L = C.PROFILE_LIMITS;
  const p = {
    fullName: text(o.fullName, L.fullName, 'profile.fullName'),
    company: text(o.company, L.company, 'profile.company'),
    jobTitle: text(o.jobTitle, L.jobTitle, 'profile.jobTitle'),
    country: null,
    phone: text(o.phone, L.phone, 'profile.phone'),
  };
  if (o.country !== undefined && o.country !== null && o.country !== '') {
    if (C.COUNTRIES.indexOf(o.country) === -1) fail('bad_request', { field: 'profile.country' });
    p.country = o.country;
  }
  if (p.phone !== null && (!/^[0-9+() ./-]+$/.test(p.phone) || (p.phone.match(/[0-9]/g) || []).length < 3)) fail('bad_request', { field: 'profile.phone' });
  return p;
}
const emptyProfile = () => ({ fullName: null, company: null, jobTitle: null, country: null, phone: null });
const isEmptyProfile = (p) => C.PROFILE_KEYS.every((k) => p[k] === null);
// a stored value read back: only the known keys, each text or null (a damaged value reads as none)
function cleanProfile(o) {
  if (!isObj(o)) return null;
  const p = emptyProfile();
  for (const k of C.PROFILE_KEYS) if (typeof o[k] === 'string' && o[k]) p[k] = o[k];
  return isEmptyProfile(p) ? null : p;
}
function sealProfile(u, p) { return isEmptyProfile(p) ? null : u.seal(PROFILE_FIELD, JSON.stringify(p)); }
function openProfile(u, buf) {
  if (buf == null) return null;
  try { return cleanProfile(JSON.parse(u.open(PROFILE_FIELD, buf))); } catch (e) { return null; }
}

function list(arr, max, each, field) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr) || arr.length > max) fail('bad_request', { field });
  const out = [];
  arr.forEach((v, i) => { const t = each(v, field + '[' + i + ']'); if (t && out.indexOf(t) === -1) out.push(t); });
  return out;
}
function normSummary(o) {
  const keys = C.SUMMARY_TEXT.concat(['wells', 'modules']);
  onlyKeys(o, keys, 'summary');
  const L = C.SUMMARY_LIMITS;
  const s = {};
  for (const k of C.SUMMARY_TEXT) s[k] = text(o[k], L.text, 'summary.' + k);
  s.wells = list(o.wells, L.wells, (v, f) => { if (typeof v !== 'string') fail('bad_request', { field: f }); return text(v, L.well, f); }, 'summary.wells');
  s.modules = list(o.modules, L.modules, (v, f) => { if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(v)) fail('bad_request', { field: f }); return v; }, 'summary.modules');
  return s;
}
function cleanSummary(o) {
  if (!isObj(o)) return null;
  const s = {};
  for (const k of C.SUMMARY_TEXT) s[k] = typeof o[k] === 'string' && o[k] ? o[k] : null;
  s.wells = Array.isArray(o.wells) ? o.wells.filter((w) => typeof w === 'string' && w).slice(0, C.SUMMARY_LIMITS.wells) : [];
  s.modules = Array.isArray(o.modules) ? o.modules.filter((w) => typeof w === 'string' && w).slice(0, C.SUMMARY_LIMITS.modules) : [];
  return s;
}
function sealSummary(u, s) { return u.seal(SUMMARY_FIELD, JSON.stringify(s)); }
function openSummary(u, buf) {
  if (buf == null) return null;
  try { return cleanSummary(JSON.parse(u.open(SUMMARY_FIELD, buf))); } catch (e) { return null; }
}

// the admin side: the account's key ring opened from data_key_wrapped (keys.ring.open), then one field
function ringOf(keys, wrapped) { try { return keys.ring.open(wrapped); } catch (e) { return null; } }
function openWith(ring, field, buf) {
  if (!ring || buf == null) return null;
  try { return E.openField(ring, field, buf).toString('utf8'); } catch (e) { return null; }
}
function profileWith(ring, buf) { const t = openWith(ring, PROFILE_FIELD, buf); try { return t == null ? null : cleanProfile(JSON.parse(t)); } catch (e) { return null; } }
function summaryWith(ring, buf) { const t = openWith(ring, SUMMARY_FIELD, buf); try { return t == null ? null : cleanSummary(JSON.parse(t)); } catch (e) { return null; } }

const keyOf = (v) => v.normalize('NFKC').trim().toLowerCase();
function distinct(values, max) {
  const seen = new Set(); const out = [];
  for (const v of values) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const k = keyOf(v);
    if (seen.has(k)) continue;
    seen.add(k); out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
// [{value, n}]: n = how many entries share the case-insensitive key; the spelling shown is the most common one (first seen
// on a tie); ordered by n descending, then the shown value
function top(values, max) {
  const groups = new Map();
  for (const v of values) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const k = keyOf(v);
    let g = groups.get(k);
    if (!g) { g = { n: 0, spell: new Map(), order: [] }; groups.set(k, g); }
    g.n++;
    if (!g.spell.has(v)) { g.spell.set(v, 0); g.order.push(v); }
    g.spell.set(v, g.spell.get(v) + 1);
  }
  const out = [];
  groups.forEach((g) => {
    let best = g.order[0];
    for (const s of g.order) if (g.spell.get(s) > g.spell.get(best)) best = s;
    out.push({ value: best, n: g.n });
  });
  out.sort((a, b) => b.n - a.n || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return out.slice(0, max);
}

// consentCurrent(row, config) — the account accepted the current Privacy notice (users.privacy_version ≥ config.privacy; the
// versions are numbers in text, anything else must match exactly). The profile and the project summaries are collected and
// shown to the operator only under the notice that describes them (privacy version 2): an account that accepted an older
// version stores neither until it accepts the current one at its next sign-in (review fix).
function consentCurrent(row, config) {
  if (!row || !config) return false;
  const have = String(row.privacy_version == null ? '' : row.privacy_version); const want = String(config.privacy == null ? '' : config.privacy);
  if (/^\d{1,6}$/.test(have) && /^\d{1,6}$/.test(want)) return Number(have) >= Number(want);
  return have !== '' && have === want;
}

// store the account's profile in the unit's transaction (the unit's user, own row under RLS) and audit which fields are set —
// never their values. via: 'signup' | 'account'
async function storeProfile(unit, p, via, deviceId) {
  const u = await unit.user();
  await unit.sql`update wts.users set profile_enc = ${sealProfile(u, p)} where id = ${unit.userId}`;
  await unit.audit('profile_update', { deviceId: deviceId || null, detail: { via, fields: C.PROFILE_KEYS.filter((k) => p[k] !== null) } });
  return p;
}

module.exports = {
  storeProfile, PROFILE_FIELD, SUMMARY_FIELD, normProfile, emptyProfile, isEmptyProfile, cleanProfile, sealProfile, openProfile,
  consentCurrent, normSummary, cleanSummary, sealSummary, openSummary, ringOf, openWith, profileWith, summaryWith, distinct, top,
};
