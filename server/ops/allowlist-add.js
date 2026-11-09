#!/usr/bin/env node
'use strict';
// server/ops/allowlist-add.js — put an address on the invite beta allow-list (ACCOUNTS_SIGNUP=invite; audited).
//   node server/ops/allowlist-add.js --actor support:<id> --email <address> [--note <text>]
const O = require('../core/ops');
require('./cli').main('allowlist-add', ['support'], (c) => O.allowlistAdd({ db: c.support, keys: c.keys, actor: c.args.actor, email: c.args.email, note: c.args.note }));
