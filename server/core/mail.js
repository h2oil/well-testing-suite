'use strict';
// server/core/mail.js — mail templates (names and required parameters) and transports (docs/ACCOUNTS-PLAN.md §4.1, §4.9,
// §4.12). Mail is plain text only and never carries client-supplied text (device labels, project names). The send is queued
// (mail_outbox) and drained after the response; tests use the memory transport, never a real service.
//
//   TEMPLATES          {name: {params:[…], kind:'code'|'notice'}}
//   render(template, params) → {subject, text}  (plain text; the wording of §4.1 / §4.3 / §8.5)
//   compose(msg)       → msg + {subject, text}: what every send path hands the transport (after-response send, daily retry,
//                        the daily job's own notices)
//   memoryTransport()  → {send(msg) → Promise, sent:[msg], last(to?), codeFor(to, template?)}; msg = {to, template, params,
//                        subject?, text?}
//   checkMessage(msg)  → null | error text

const TEMPLATES = {
  code_signin: { kind: 'code', params: ['code', 'browser', 'os', 'at'] },
  code_stepup: { kind: 'code', params: ['code', 'browser', 'os', 'at'] },
  code_email_change: { kind: 'code', params: ['code'] },
  code_recovery_add: { kind: 'code', params: ['code'] },
  code_oauth_verify: { kind: 'code', params: ['code', 'provider'] },
  code_link_confirm: { kind: 'code', params: ['code', 'provider', 'providerEmailMasked'] },
  code_cancel_deletion: { kind: 'code', params: ['code'] },
  notice_new_device: { kind: 'notice', params: ['browser', 'os', 'at'] },
  notice_email_changed: { kind: 'notice', params: ['at', 'revertCode'] },
  notice_email_reverted: { kind: 'notice', params: ['at'] },
  notice_email_added: { kind: 'notice', params: ['at'] },                 // to the NEW address of an e-mail change (WP-S1)
  notice_recovery_set: { kind: 'notice', params: ['at'] },
  notice_recovery_removed: { kind: 'notice', params: ['at'] },
  notice_identity_linked: { kind: 'notice', params: ['provider', 'browser', 'os', 'at'] },
  notice_identity_unlinked: { kind: 'notice', params: ['provider', 'at'] },
  notice_passkey_added: { kind: 'notice', params: ['at'] },
  notice_passkey_removed: { kind: 'notice', params: ['at'] },
  notice_signout_all: { kind: 'notice', params: ['at'] },
  notice_device_revoked: { kind: 'notice', params: ['at'] },
  notice_export: { kind: 'notice', params: ['at'] },
  notice_delete_requested: { kind: 'notice', params: ['deleteAt'] },
  notice_delete_cancelled: { kind: 'notice', params: ['at'] },
  notice_read_burst: { kind: 'notice', params: ['at'] },
  notice_commit_burst: { kind: 'notice', params: ['at'] },
  notice_codes_paused: { kind: 'notice', params: ['at'] },                // 10 failed codes in 24 h (§8.3; WP-S1)
  notice_inactivity: { kind: 'notice', params: ['deleteAt'] },            // 23 / 23.5 months without a sign-in (§8.5; WP-S1)
  notice_delete_done: { kind: 'notice', params: ['at'] },                 // the purge ran (§4.9; WP-S1)
  notice_ops_test: { kind: 'notice', params: ['at'] },                    // the operator's delivery test (site/handler.js ops self-test)
};

// ── plain-text bodies (§4.1, §4.3, §4.9, §8.5) ──────────────────────────────────────────────────────────────────
// Every value is re-checked against a fixed pattern or a fixed word list before it goes into a mail: codes are 8 digits
// (shown as "1234 5678"), times are server-made ("YYYY-MM-DD HH:MM UTC" or a date), browser and OS are the generic words of
// service.uaFamily, providers are Google or LinkedIn by key. Nothing a client typed (device labels, project names, a
// User-Agent string) can reach a mail; there is no HTML.
const SITE = 'welltest.h2oil.co.uk';
const BROWSERS = new Set(['a web browser']);
const OSES = new Set(['a computer', 'a phone or tablet']);
const PROVIDERS = { google: 'Google', linkedin: 'LinkedIn' };
const fmtCode = (c) => { const s = String(c == null ? '' : c); if (!/^\d{8}$/.test(s)) throw new Error('mail: code must be 8 digits'); return s.slice(0, 4) + ' ' + s.slice(4); };
const fmtKey = (k) => { const s = String(k == null ? '' : k); if (!/^[A-Z2-7]{26}$/.test(s)) throw new Error('mail: revert key must be 26 of A-Z / 2-7'); return s; };
const fmtWhen = (t) => { const s = String(t == null ? '' : t); return /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2} UTC)?$/.test(s) ? s : 'an unknown time'; };
const fmtBrowser = (p) => (BROWSERS.has(p.browser) ? p.browser : 'a web browser');
const fmtOs = (p) => (OSES.has(p.os) ? p.os : 'a device');
const fmtProvider = (p) => PROVIDERS[String(p.provider || '').toLowerCase()] || 'your sign-in provider';
const fmtMasked = (m) => { const s = String(m == null ? '' : m); return /^[A-Za-z0-9._%+•-]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(s) && s.includes('•') ? s : null; };
const ONLY_HERE = 'Only enter this code at ' + SITE + ' - we will never ask you for it.';
const EXPIRES = 'It expires in 15 minutes.';
const from = (p) => 'Requested from ' + fmtBrowser(p) + ' on ' + fmtOs(p) + ' at ' + fmtWhen(p.at) + '.';
const IGNORE = 'If you did not ask for it, ignore this e-mail.';
const NOT_YOU = 'If this was not you, sign in at ' + SITE + ', open Account and choose Sign out everywhere, or reply to software@h2oil.co.uk.';
const FOOTER = '\n\n-- \nWell Testing Suite - ' + SITE + '\nThis is an automatic message; replies to this address are not read.';

const BODIES = {
  code_signin: (p) => ['Your Well Testing Suite sign-in code', [
    'Your Well Testing Suite sign-in code is ' + fmtCode(p.code) + '. ' + EXPIRES, ONLY_HERE, from(p), IGNORE]],
  code_stepup: (p) => ['Your Well Testing Suite confirmation code', [
    'Your Well Testing Suite confirmation code is ' + fmtCode(p.code) + '. ' + EXPIRES, ONLY_HERE, from(p),
    'If you did not ask for it, someone may be signed in to your account: ' + NOT_YOU.slice('If this was not you, '.length)]],
  code_email_change: (p) => ['Confirm your new Well Testing Suite e-mail address', [
    'Your code to make this the e-mail address of your Well Testing Suite account is ' + fmtCode(p.code) + '. ' + EXPIRES, ONLY_HERE, IGNORE]],
  code_recovery_add: (p) => ['Confirm your Well Testing Suite recovery address', [
    'Your code to add this address as the recovery address of a Well Testing Suite account is ' + fmtCode(p.code) + '. ' + EXPIRES, ONLY_HERE, IGNORE]],
  code_oauth_verify: (p) => ['Your Well Testing Suite sign-in code', [
    'You are signing in to the Well Testing Suite with ' + fmtProvider(p) + '. Your code is ' + fmtCode(p.code) + '. ' + EXPIRES, ONLY_HERE, IGNORE]],
  code_link_confirm: (p) => {
    const m = fmtMasked(p.providerEmailMasked);
    return ['Confirm linking ' + fmtProvider(p) + ' to your Well Testing Suite account', [
      'Your code to link the ' + fmtProvider(p) + ' account' + (m ? ' ' + m : '') + ' to your Well Testing Suite account is ' + fmtCode(p.code) + '. ' + EXPIRES,
      ONLY_HERE, 'If you did not ask for it, do not enter the code; nothing is linked without it.']];
  },
  code_cancel_deletion: (p) => ['Your code to cancel the deletion of your Well Testing Suite account', [
    'Your Well Testing Suite account is being deleted. Your code to sign in and cancel the deletion is ' + fmtCode(p.code) + '. ' + EXPIRES, ONLY_HERE, IGNORE]],
  notice_new_device: (p) => ['New sign-in to your Well Testing Suite account', [
    'New sign-in on ' + fmtBrowser(p) + ' on ' + fmtOs(p) + ' at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_email_changed: (p) => ['The e-mail address of your Well Testing Suite account was changed', [
    'The e-mail address of your Well Testing Suite account was changed on ' + fmtWhen(p.at) + '.',
    'If this was not you, open ' + SITE + '/#account-revert=' + fmtKey(p.revertCode) + ' within 7 days (or open ' + SITE + '/#account-revert '
      + 'and enter the revert key ' + fmtKey(p.revertCode).replace(/(.{4})(?=.)/g, '$1 ') + '). This restores this address, signs '
      + 'out every session and removes every passkey, recovery address and Google or LinkedIn sign-in added since the change.']],
  notice_email_reverted: (p) => ['The e-mail address of your Well Testing Suite account was restored', [
    'The e-mail address of your Well Testing Suite account was restored to this address on ' + fmtWhen(p.at) + '. Every session was signed out, '
      + 'and passkeys, a recovery address and Google or LinkedIn sign-ins added since the change were removed.']],
  notice_email_added: (p) => ['This is now the e-mail address of your Well Testing Suite account', [
    'This address became the e-mail address of a Well Testing Suite account on ' + fmtWhen(p.at) + '. Sign-in codes now come here.']],
  notice_recovery_set: (p) => ['A recovery address was set on a Well Testing Suite account', [
    'A recovery address was set on the Well Testing Suite account of this address on ' + fmtWhen(p.at) + '. Sign-in codes can also be sent to it.', NOT_YOU]],
  notice_recovery_removed: (p) => ['A recovery address was removed from a Well Testing Suite account', [
    'The recovery address of the Well Testing Suite account of this address was removed or replaced on ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_identity_linked: (p) => [fmtProvider(p) + ' sign-in was linked to your Well Testing Suite account', [
    'Sign in with ' + fmtProvider(p) + ' was linked to your Well Testing Suite account from ' + fmtBrowser(p) + ' on ' + fmtOs(p) + ' at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_identity_unlinked: (p) => [fmtProvider(p) + ' sign-in was removed from your Well Testing Suite account', [
    'Sign in with ' + fmtProvider(p) + ' was removed from your Well Testing Suite account at ' + fmtWhen(p.at) + '. The sessions it created were signed out.', NOT_YOU]],
  notice_passkey_added: (p) => ['A passkey was added to your Well Testing Suite account', ['A passkey was added to your Well Testing Suite account at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_passkey_removed: (p) => ['A passkey was removed from your Well Testing Suite account', ['A passkey was removed from your Well Testing Suite account at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_signout_all: (p) => ['Your Well Testing Suite account was signed out everywhere', [
    'Every session of your Well Testing Suite account was signed out at ' + fmtWhen(p.at) + '.', 'If this was not you, sign in again with a code and check Account.']],
  notice_device_revoked: (p) => ['A device was signed out of your Well Testing Suite account', ['A device was signed out of your Well Testing Suite account at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_export: (p) => ['An export of your Well Testing Suite account was started', ['An export of everything in your Well Testing Suite account was started at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_delete_requested: (p) => ['Your Well Testing Suite account will be deleted', [
    'Your Well Testing Suite account and its cloud projects will be deleted on ' + fmtWhen(p.deleteAt) + '. Every session was signed out, and Google or '
      + 'LinkedIn sign-ins were removed from the account.',
    'To cancel: before that time, sign in at ' + SITE + ' with a code sent to this address and choose Cancel deletion.',
    'We hold no Google or LinkedIn token, so nothing is removed at those services. If you signed in with Google or LinkedIn, you can remove the '
      + 'Well Testing Suite\'s access in your Google Account settings (third-party access) and in LinkedIn\'s settings (permitted services).',
    'Data on your own devices is not touched.']],
  notice_delete_cancelled: (p) => ['The deletion of your Well Testing Suite account was cancelled', [
    'The deletion of your Well Testing Suite account was cancelled at ' + fmtWhen(p.at) + '.',
    'Google or LinkedIn sign-ins removed at the deletion request are not restored; link them again from Account if you use them.']],
  notice_read_burst: (p) => ['Unusual reading from your Well Testing Suite account', [
    'A session of your Well Testing Suite account read an unusual amount of data at ' + fmtWhen(p.at) + '.', NOT_YOU]],
  notice_commit_burst: (p) => ['Unusual saving to your Well Testing Suite account', [
    'A project of your Well Testing Suite account was saved unusually often at ' + fmtWhen(p.at) + '. The version before the burst is kept for 7 days.', NOT_YOU]],
  notice_codes_paused: (p) => ['Sign-in codes for your Well Testing Suite account are paused', [
    'Ten wrong codes were entered for this address in 24 hours (the last at ' + fmtWhen(p.at) + '). Codes for it are paused for one hour.',
    'If this was not you, someone may be guessing; nothing else changed.']],
  notice_inactivity: (p) => ['Your Well Testing Suite account will be deleted for inactivity', [
    'Nobody has signed in to your Well Testing Suite account for 23 months. It will be deleted after ' + fmtWhen(p.deleteAt) + ' unless you sign in at ' + SITE + ' before then.']],
  notice_delete_done: (p) => ['Your Well Testing Suite account was deleted', [
    'Your Well Testing Suite account and its cloud projects were deleted at ' + fmtWhen(p.at) + '. Backups age out within 30 days. Data on your own devices is not touched.']],
  notice_ops_test: (p) => ['Well Testing Suite e-mail delivery test', [
    'This is a test message from the Well Testing Suite account service at ' + SITE + ', sent at ' + fmtWhen(p.at) + ' by its operator to check that e-mail is delivered.',
    'No account was created or changed. If you did not expect it, ignore this e-mail.']],
};

// render(template, params) → {subject, text}; throws on an unknown template or a missing / malformed parameter
function render(template, params) {
  const t = TEMPLATES[template];
  const b = BODIES[template];
  if (!t || !b) throw new Error('mail: unknown template ' + template);
  const p = params || {};
  for (const k of t.params) if (p[k] === undefined || p[k] === null) throw new Error('mail: params.' + k + ' missing');
  const [subject, lines] = b(p);
  return { subject, text: lines.join('\n\n') + FOOTER };
}
// the message a transport gets: {to, template, params, subject, text}
function compose(msg) { return Object.assign({}, msg, render(msg.template, msg.params)); }

function checkMessage(msg) {
  if (!msg || typeof msg.to !== 'string' || msg.to.indexOf('@') < 1) return 'to: expected an address';
  const t = TEMPLATES[msg.template];
  if (!t) return 'template: unknown ' + msg.template;
  const p = msg.params || {};
  for (const k of t.params) if (p[k] === undefined || p[k] === null) return 'params.' + k + ': missing';
  return null;
}
function memoryTransport(o) {
  o = o || {};
  const sent = [];
  return {
    sent,
    send(msg) {
      const e = checkMessage(msg);
      if (e) return Promise.reject(new Error('mail: ' + e));
      sent.push(JSON.parse(JSON.stringify(msg)));
      return o.delay ? new Promise((r) => o.delay(r)) : Promise.resolve();
    },
    last(to) { for (let i = sent.length - 1; i >= 0; i--) if (!to || sent[i].to === to) return sent[i]; return null; },
    codeFor(to, template) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const m = sent[i];
        if (m.to === to && TEMPLATES[m.template].kind === 'code' && (!template || m.template === template)) return m.params.code;
      }
      return null;
    },
  };
}

module.exports = { TEMPLATES, checkMessage, memoryTransport, render, compose, BODIES };
