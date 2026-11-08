'use strict';
// server/functions/blobs.js — Content-addressed, immutable, chunked parts (§3.3 Blobs, D11 envelope encryption). WP-S1.
// WP0 foundation: every handler is a stub that answers 501 not_implemented through the common pipeline (core/app.js), so
// the Origin / header / shape rules and the error envelope already hold. The work package replaces the stubs.

const { fail } = require('../core/errors');

const stub = () => fail('not_implemented');

module.exports = {
  handlers: {
    blobsHas: stub,
    blobPut: stub,
    blobGet: stub,
  },
};
