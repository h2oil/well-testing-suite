'use strict';
// server/test/mail.test.js — the plain-text bodies of every code and notice (docs/ACCOUNTS-PLAN.md §4.1, §4.3, §4.9, §8.5):
// one check per template (subject and text, no HTML, no client-supplied string, the code shown as "1234 5678"), the fixed
// wording of the sign-in code, the revert notice and the deletion notice, and that every send path hands the transport a
// rendered message. No database.

const test = require('node:test');
const assert = require('node:assert');
const M = require('../core/mail');
const S = require('../core/service');

const AT = '2026-11-08 12:00 UTC';
const EVIL = '<b>Office PC</b> javascript:alert(1)';
const ua = S.uaFamily('SomeAgent/5.0 (DesktopOS 10.0) EvilBrowser/9 ' + EVIL);
function paramsFor(name) {
  const p = {};
  for (const k of M.TEMPLATES[name].params) {
    p[k] = { code: '12345678', revertCode: '87654321', browser: ua.browser, os: ua.os, at: AT, deleteAt: AT, provider: 'google',
      providerEmailMasked: 'p•••@company.example' }[k];
  }
  // a client string smuggled in as extra parameters must never be used
  return Object.assign(p, { label: EVIL, deviceLabel: EVIL, name: EVIL, userAgent: EVIL });
}

test.describe('mail bodies (§4.1, §4.3, §8.5)', () => {
  for (const name of Object.keys(M.TEMPLATES)) {
    test(name + ': plain text, generic words only, no client string', () => {
      const r = M.render(name, paramsFor(name));
      assert.ok(typeof r.subject === 'string' && r.subject.length > 5 && !/[\r\n]/.test(r.subject), 'one-line subject');
      assert.ok(typeof r.text === 'string' && r.text.length > 40);
      assert.ok(!/[<>]/.test(r.text + r.subject), 'no HTML');
      assert.ok(!/Office PC|javascript|EvilBrowser|DesktopOS|SomeAgent/.test(r.text + r.subject), 'no label, no User-Agent text');
      assert.ok(/welltest\.h2oil\.co\.uk/.test(r.text), 'names the only site');
      if (M.TEMPLATES[name].kind === 'code') {
        assert.ok(r.text.includes('1234 5678'), 'the code as 1234 5678');
        assert.ok(!r.text.includes('12345678'), 'never unformatted');
        assert.ok(/Only enter this code at welltest\.h2oil\.co\.uk/.test(r.text));
        assert.ok(/expires in 15 minutes/.test(r.text));
      }
      if (M.TEMPLATES[name].params.includes('at')) assert.ok(r.text.includes(AT), 'the server time');
    });
  }

  test('sign-in code: the §4.1 wording with browser, OS and time', () => {
    const r = M.render('code_signin', { code: '12345678', browser: ua.browser, os: ua.os, at: AT });
    assert.ok(r.text.startsWith('Your Well Testing Suite sign-in code is 1234 5678. It expires in 15 minutes.'));
    assert.ok(r.text.includes('Requested from a web browser on a computer at ' + AT + '.'));
    assert.ok(r.text.includes('If you did not ask for it, ignore this e-mail.'));
    const odd = M.render('code_signin', { code: '12345678', browser: EVIL, os: EVIL, at: EVIL });
    assert.ok(odd.text.includes('Requested from a web browser on a device at an unknown time.'), 'unknown values fall back to fixed words');
  });

  test('revert notice: the code and the #account-revert link, 7 days (§4.3)', () => {
    const r = M.render('notice_email_changed', { at: AT, revertCode: '87654321' });
    assert.ok(r.text.includes('enter code 8765 4321 at welltest.h2oil.co.uk/#account-revert within 7 days'));
  });

  test('deletion notice: date, how to cancel, where to remove app access at Google and LinkedIn (§8.5)', () => {
    const r = M.render('notice_delete_requested', { deleteAt: AT });
    assert.ok(r.text.includes(AT));
    assert.ok(/choose Cancel deletion/.test(r.text) && /code sent to this address/.test(r.text));
    assert.ok(/Google Account/.test(r.text) && /LinkedIn's settings/.test(r.text));
    assert.ok(/LinkedIn/.test(M.render('notice_delete_cancelled', { at: AT }).text), 'the cancel mail says links are not restored');
  });

  test('providers by key only; a malformed code or a missing parameter throws', () => {
    assert.ok(M.render('code_oauth_verify', { code: '12345678', provider: 'linkedin' }).text.includes('with LinkedIn'));
    assert.ok(M.render('code_oauth_verify', { code: '12345678', provider: EVIL }).text.includes('your sign-in provider'));
    assert.ok(!M.render('code_link_confirm', { code: '12345678', provider: 'google', providerEmailMasked: EVIL }).text.includes('Office'));
    assert.throws(() => M.render('code_signin', { code: '1234', browser: 'a web browser', os: 'a computer', at: AT }), /8 digits/);
    assert.throws(() => M.render('code_signin', { code: '12345678' }), /missing/);
    assert.throws(() => M.render('nope', {}), /unknown template/);
  });

  test('compose: the transport gets subject and text with the template and parameters', async () => {
    const t = M.memoryTransport();
    await t.send(M.compose({ to: 'a@company.example', template: 'notice_export', params: { at: AT } }));
    assert.strictEqual(t.sent[0].template, 'notice_export');
    assert.ok(t.sent[0].subject && t.sent[0].text.includes(AT));
  });

  test('every template has a body', () => {
    assert.deepStrictEqual(Object.keys(M.BODIES).sort(), Object.keys(M.TEMPLATES).sort());
  });
});
