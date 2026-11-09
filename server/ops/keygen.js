#!/usr/bin/env node
'use strict';
// server/ops/keygen.js — generates every secret value of the functions site in the exact form core/config.js reads
// (server/RUNBOOK.md §3N "Switch it on with Netlify", step 3). Run it on the owner's own computer; it prints NAME=value lines to
// the terminal only (nothing is written to disk, nothing is sent anywhere). Copy each value straight into the site's
// environment variables (marked "Contains secret values") and into the password manager; close the terminal afterwards.
//
//   node server/ops/keygen.js              production values (key ids 1)
//   node server/ops/keygen.js --preview    values for a test / preview site (key ids 9001: site/isolation.js refuses
//                                          production key ids outside production and preview ids in production)
//   require('./keygen').generate({preview}) → [{name, value, secret, where, note}]

const crypto = require('crypto');
const { generateBackupKeys } = require('../site/backup');

const b64 = () => crypto.randomBytes(32).toString('base64');
function generate(o) {
  o = o || {};
  const kid = o.preview ? 9001 : 1;
  const backup = generateBackupKeys(kid);
  return [
    { name: 'WTS_MASTER_KEYS', value: kid + ':' + b64(), secret: true, where: 'functions site', note: 'also to the OFFLINE escrow' },
    { name: 'WTS_MASTER_KID', value: String(kid), secret: false, where: 'functions site' },
    { name: 'WTS_INDEX_PEPPER', value: b64(), secret: true, where: 'functions site' },
    { name: 'WTS_CODE_PEPPERS', value: kid + ':' + b64(), secret: true, where: 'functions site' },
    { name: 'WTS_SESSION_PEPPER', value: b64(), secret: true, where: 'functions site' },
    { name: 'WTS_OPS_HMAC', value: b64(), secret: true, where: 'functions site' },
    { name: 'WTS_PROXY_SIG', value: crypto.randomBytes(32).toString('base64url'), secret: true, where: 'functions site AND main site', note: 'the same value on both sites' },
    { name: 'WTS_BACKUP_PUBLIC_KEY', value: backup.publicKey, secret: false, where: 'functions site' },
    { name: 'WTS_BACKUP_PRIVATE_KEY', value: backup.privateKey, secret: true, where: 'NOT on any site', note: 'password manager + OFFLINE escrow only; opens the weekly exports' },
  ];
}

module.exports = { generate };

if (require.main === module) {
  const rows = generate({ preview: process.argv.includes('--preview') });
  process.stdout.write('# ' + (process.argv.includes('--preview') ? 'PREVIEW / TEST' : 'PRODUCTION') + ' values — never paste them into chat, e-mail, a ticket or the repository\n');
  rows.forEach((r) => process.stdout.write('\n# ' + r.where + (r.secret ? ' — secret' : '') + (r.note ? ' — ' + r.note : '') + '\n' + r.name + '=' + r.value + '\n'));
}
