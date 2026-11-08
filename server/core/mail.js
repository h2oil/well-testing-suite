'use strict';
// server/core/mail.js — mail templates (names and required parameters) and transports (docs/ACCOUNTS-PLAN.md §4.1, §4.9,
// §4.12). Mail is plain text only and never carries client-supplied text (device labels, project names). The send is queued
// (mail_outbox) and drained after the response; tests use the memory transport, never a real service.
//
//   TEMPLATES          {name: {params:[…], kind:'code'|'notice'}}
//   memoryTransport()  → {send(msg) → Promise, sent:[msg], last(to?), codeFor(to, template?)}; msg = {to, template, params}
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
};

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

module.exports = { TEMPLATES, checkMessage, memoryTransport };
