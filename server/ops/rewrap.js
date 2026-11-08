#!/usr/bin/env node
'use strict';
// server/ops/rewrap.js — §13.4 master-key rotation: re-wrap every account's key ring with --to-kid (both kids loaded in
// WTS_MASTER_KEYS), then report the rings per kid. Retire the old kid only when no row uses it.
//   node server/ops/rewrap.js --to-kid <n>
const O = require('../core/ops');
require('./cli').main('rewrap', ['jobs'], async (c) => {
  const r = await O.rewrapAll({ db: c.jobs, keys: c.keys, toKid: Number(c.args['to-kid']) });
  return Object.assign(r, { status: await O.ringStatus({ db: c.jobs, keys: c.keys }) });
});
