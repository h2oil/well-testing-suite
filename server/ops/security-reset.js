#!/usr/bin/env node
'use strict';
// server/ops/security-reset.js — §13.6 containment for one account: revoke every session; remove passkeys, provider links
// (with their sessions) and the recovery address added since --since; revert an e-mail change made in the window (audited).
//   node server/ops/security-reset.js --actor support:<id> --user <uuid> --since <ISO time>
const O = require('../core/ops');
require('./cli').main('security-reset', ['support'], (c) => {
  if (!c.args.since || isNaN(Date.parse(c.args.since))) throw new Error('--since <ISO time> is required');
  return O.securityReset({ db: c.support, actor: c.args.actor, userId: c.args.user, since: new Date(c.args.since) });
});
