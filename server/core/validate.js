'use strict';
// server/core/validate.js — input normalisation shared by the server and the fake server (docs/ACCOUNTS-PLAN.md §4.1, §3.2).

const { checkShape } = require('./contract');
const { ApiError } = require('./errors');

// Trim, NFKC, lower-case; refuse anything that is not one plausible address of ≤ 254 characters (→ null).
function normEmail(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').trim().toLowerCase();
  if (!s || s.length > 254 || /[\s,;<>()[\]\\"]/.test(s)) return null;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return null;
  if (!/^[^.\s]+(\.[^.\s]+)+$/.test(s.slice(at + 1))) return null;
  return s;
}
function domainOf(email) { const at = email.lastIndexOf('@'); return at < 0 ? '' : email.slice(at + 1); }
// 'name@company.example' → 'n•••@company.example' (the form every response and mail uses)
function maskEmail(email) {
  if (!email) return null;
  const at = email.indexOf('@');
  return (at > 0 ? email[0] : '') + '•••' + email.slice(at);
}
function normCode(raw) { return typeof raw === 'string' ? raw.replace(/\s/g, '') : ''; }
// the revert key: spaces and hyphens dropped, upper case; null unless exactly 26 characters of A–Z / 2–7
function normRevertKey(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const k = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{26}$/.test(k) ? k : null;
}
const LABEL_RE = /^[A-Za-z0-9 _.()-]{0,40}$/;
function isLabel(s) { return typeof s === 'string' && LABEL_RE.test(s); }
// Validate a parsed body against a contract request shape; throws 400 bad_request naming the first failing field.
function requireShape(shapeName, body) {
  const r = checkShape(shapeName, body);
  if (r.ok) return body;
  const first = r.errors[0] || '';
  const field = first.split(':')[0].replace(/^\(root\)$/, '').split(/[.[]/)[0] || undefined;
  throw new ApiError('bad_request', field ? { field } : {});
}
// IPv4 /24 or IPv6 /48 prefix of an address (§3.2); unknown → null
function ipPrefix(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return v4[1] + '.' + v4[2] + '.' + v4[3] + '.0/24';
  if (ip.indexOf(':') !== -1) {
    const head = (ip.split('::')[0] || '').split(':').filter((h) => h !== '');
    while (head.length < 3) head.push('0');
    return head.slice(0, 3).join(':') + '::/48';
  }
  return null;
}

module.exports = { normEmail, domainOf, maskEmail, normCode, normRevertKey, isLabel, requireShape, ipPrefix };
