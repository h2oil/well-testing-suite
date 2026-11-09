#!/usr/bin/env node
'use strict';
// server/ops/ledger-replay.js — §13.5: after ANY database restore and before the API is re-opened, purge again every
// account named in the ledger objects (ledger/<user id>, written outside the restorable database by the daily job).
//   [WTS_OBJECTS_BINDING=<binding module> | site/objects-binding.js | WTS_OBJECTS_DIR=<blob store folder>] node server/ops/ledger-replay.js
// The blob store is the one the API writes (site/objects-loader.js, the same choice as the functions entry and the weekly
// export); without one the replay refuses to run.
const { ledgerReplay } = require('../core/jobs');
const { loadObjects } = require('../site/objects-loader');
require('./cli').main('ledger-replay', ['jobs'], (c) => {
  const { objects } = loadObjects(process.env, { required: true });
  return ledgerReplay({ db: c.jobs, objects });
});
