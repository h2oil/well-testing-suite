#!/usr/bin/env node
'use strict';
// server/ops/lookup.js — find an account by an address (support_lookup; one audit row, actor support:<id>).
//   node server/ops/lookup.js --actor support:<id> --email <address>
const O = require('../core/ops');
require('./cli').main('lookup', ['support'], (c) => O.lookup({ db: c.support, keys: c.keys, actor: c.args.actor, email: c.args.email }));
