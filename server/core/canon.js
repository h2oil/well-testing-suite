'use strict';
// server/core/canon.js — canonical JSON and SHA-256 (docs/ACCOUNTS-PLAN.md D5: parts are content-addressed by the SHA-256
// of canonical JSON). Canonical form: object keys sorted by UTF-16 code units, no whitespace, numbers and strings as
// JSON.stringify writes them (non-finite numbers refused), undefined members dropped, arrays keep order (undefined → null).
// The client (67) must implement the same function; the contract test checks the reference vectors in _acct-shapes.js.

const crypto = require('crypto');

function canonical(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') { if (!isFinite(v)) throw new Error('canon: non-finite number'); return JSON.stringify(v); }
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error('canon: unsupported type ' + typeof v);
}
function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hashOf(v) { return sha256Hex(Buffer.from(canonical(v), 'utf8')); }

module.exports = { canonical, sha256Hex, hashOf };
