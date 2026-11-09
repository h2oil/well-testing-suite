'use strict';
// server/functions/index.js — the handler table: one entry per contract endpoint id (core/contract.js ENDPOINTS), merged
// from the route-group files. Loading fails if a group defines an unknown id or two groups define the same id; a missing id
// answers 501 not_implemented (core/app.js) and is reported by `missing()` (server/test/contract.test.js requires none).

const { ENDPOINTS } = require('../core/contract');

const FILES = ['auth', 'oauth', 'me', 'projects', 'blobs', 'library', 'account', 'health', 'csp-report', 'ops-daily', 'admin'];
const ids = new Set(ENDPOINTS.map((e) => e.id));
const handlers = {};
FILES.forEach((f) => {
  const mod = require('./' + f);
  Object.keys(mod.handlers).forEach((id) => {
    if (!ids.has(id)) throw new Error('functions/' + f + ': unknown endpoint id ' + id);
    if (handlers[id]) throw new Error('functions/' + f + ': ' + id + ' defined twice');
    handlers[id] = mod.handlers[id];
  });
});
function missing() { return ENDPOINTS.map((e) => e.id).filter((id) => !handlers[id]); }

module.exports = { handlers, FILES, missing };
