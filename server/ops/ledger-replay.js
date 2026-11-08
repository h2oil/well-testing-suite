#!/usr/bin/env node
'use strict';
// server/ops/ledger-replay.js — §13.5: after ANY database restore and before the API is re-opened, purge again every
// account named in the ledger objects (ledger/<user id>, written outside the restorable database by the daily job).
//   WTS_OBJECTS_DIR=<folder of a filesystem object store> node server/ops/ledger-replay.js
// (the host's blob store adapter of WP-OPS replaces the filesystem store in production)
const { ledgerReplay } = require('../core/jobs');
const { fsObjects } = require('../core/objects');
require('./cli').main('ledger-replay', ['jobs'], (c) => {
  if (!process.env.WTS_OBJECTS_DIR) throw new Error('WTS_OBJECTS_DIR is not set');
  return ledgerReplay({ db: c.jobs, objects: fsObjects(process.env.WTS_OBJECTS_DIR) });
});
