#!/usr/bin/env node
'use strict';
// server/ops/recover.js — §13.7 lost-mailbox recovery, ONLY after the documented identity check (RUNBOOK): the new address
// (already proved by a code) becomes the primary; the old one gets the 7-day revert window; every session is revoked (audited).
//   node server/ops/recover.js --actor support:<id> --user <uuid> --email <new address>
const O = require('../core/ops');
require('./cli').main('recover', ['support', 'jobs'], (c) => O.recover({ db: c.support, jobsDb: c.jobs, keys: c.keys, actor: c.args.actor, userId: c.args.user, newEmail: c.args.email }));
