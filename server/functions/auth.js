'use strict';
// server/functions/auth.js — Auth (§3.3, §4): e-mail codes, e-mail change and revert, recovery address, passkeys (Phase 3), sign-out, sign-in
// methods. WP-S1 (codes, sessions) / WP-C3 (passkeys); GET /auth/methods and
// POST /auth/methods/unlink are in functions/oauth.js (WP-O).
// WP0 foundation: every handler is a stub that answers 501 not_implemented through the common pipeline (core/app.js), so
// the Origin / header / shape rules and the error envelope already hold. The work package replaces the stubs.

const { fail } = require('../core/errors');

const stub = () => fail('not_implemented');

module.exports = {
  handlers: {
    codeStart: stub,
    codeVerify: stub,
    emailChange: stub,
    emailConfirm: stub,
    emailRevert: stub,
    recoverySet: stub,
    recoveryRemove: stub,
    passkeyOptions: stub,
    passkeyVerify: stub,
    passkeyRegisterOptions: stub,
    passkeyRegisterVerify: stub,
    passkeyRename: stub,
    passkeyRemove: stub,
    signOut: stub,
    signOutAll: stub,
    // methods / unlink live in functions/oauth.js (WP-O)
  },
};
