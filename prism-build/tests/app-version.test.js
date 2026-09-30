// The version under the logo (#appVersionLabel) follows the newest RELEASE_NOTES entry (v3.0.2:
// it was hard-coded "v1.7" through v3.0.1).
'use strict';
module.exports = [
  {
    name: 'sidebar version label equals the newest release-notes version',
    wp: 'UX',
    run(app, assert) {
      app.flush(20);
      const lbl = app.el('appVersionLabel');
      assert.ok(lbl, '#appVersionLabel exists');
      const m = /const RELEASE_NOTES = \[\s*\{ ver:'(v[0-9.]+)'/.exec(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'well-testing-app.html'), 'utf8'));
      assert.ok(m, 'RELEASE_NOTES found');
      assert.strictEqual(String(lbl.textContent).trim(), 'Well Testing Suite ' + m[1]);
      assert.ok(!/v1\.7/.test(lbl.textContent), 'no stale v1.7');
    },
  },
];
