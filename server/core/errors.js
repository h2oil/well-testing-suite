'use strict';
// server/core/errors.js — the error envelope of docs/ACCOUNTS-PLAN.md §3.2: {"error":"<code>","message":"<plain text>",
// "retryAfter":<s>?, ...extra}. `ApiError` is thrown by handlers; `toResponse` turns any throw into an envelope (unknown
// throws become a plain 500 with no detail — never a stack, a value or a secret).

const { ERRORS } = require('./contract');

class ApiError extends Error {
  constructor(code, extra) {
    const def = ERRORS[code];
    if (!def) throw new Error('errors: unknown code ' + code);
    super(code);
    this.code = code;
    this.status = def.status;
    this.extra = extra || {};
  }
}
function envelope(code, extra) {
  const def = ERRORS[code];
  const body = { error: code, message: def.text };
  Object.keys(extra || {}).forEach((k) => { if (k !== 'error' && k !== 'message' && extra[k] !== undefined) body[k] = extra[k]; });
  return { status: def.status, body };
}
function toResponse(e) {
  if (e instanceof ApiError) return envelope(e.code, e.extra);
  return { status: 500, body: { error: 'server', message: 'Server error.' } };
}
const fail = (code, extra) => { throw new ApiError(code, extra); };

module.exports = { ApiError, envelope, toResponse, fail };
