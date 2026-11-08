'use strict';
// server/functions/projects.js — Cloud projects: list, create, head, revisions, commit (CAS, inline core, pushId), rename, trash, restore,
// purge, restore-rev, duplicate (§3.3, D5, D6). WP-S1.
// WP0 foundation: every handler is a stub that answers 501 not_implemented through the common pipeline (core/app.js), so
// the Origin / header / shape rules and the error envelope already hold. The work package replaces the stubs.

const { fail } = require('../core/errors');

const stub = () => fail('not_implemented');

module.exports = {
  handlers: {
    projectList: stub,
    projectCreate: stub,
    projectHead: stub,
    projectRevs: stub,
    projectRev: stub,
    projectCommit: stub,
    projectRename: stub,
    projectTrash: stub,
    projectRestore: stub,
    projectPurge: stub,
    projectRestoreRev: stub,
    projectDuplicate: stub,
  },
};
