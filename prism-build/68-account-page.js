// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/68-account-page.js — the `account` page (docs/ACCOUNTS-PLAN.md §11.3): profile and security, cloud projects
// (list, filter, open, rename, duplicate, history and restore, download, trash, delete for ever, import), devices, the
// Sign-in methods card (a WP-O mount point), on this device (pre-account snapshot and stashes), storage, data (export
// everything, delete account), activity and the account help (web only; kept here so it is stripped with the page). Round-10.
//
// Same guard as 66; outside it nothing is defined. The registry entry has navHidden:true (host H7: a route, no sidebar
// button, no home tile). It is registered only with the invite-beta flag and only on a host that carries the account hooks
// (the ACCT-marked #wts_account_host of H8 lands with H7), so on an older host the page can never appear as a sidebar row.
// Every server string is put on the page escaped. Plain .card / .rbox / table.dtable markup, so reports work unchanged; the
// route is in the host skip tables (H10). No timers, polling or function wrapping.
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  function nativeShell(g) {
    try {
      var c = g.Capacitor;
      if (c && typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      return !!(c && c.isNative);
    } catch (e) { return true; }
  }
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = ((L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk') || DEV)
    && !nativeShell(G)
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) return;

  var VERSION = '1.0.0';
  var HAS_DOC = typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
  var ZIP_SPLIT = 200 * 1000 * 1000;
  var hooks = { renderMethods: null };
  function A() { return G.WTS_account || null; }
  function C() { return G.WTS_cloudSync || null; }
  function I() { var a = A(); return a && a._i ? a._i : null; }
  function $(id) { return HAS_DOC ? document.getElementById(id) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function day(iso) { return iso ? esc(String(iso).slice(0, 10)) : '—'; }
  function when(iso) { if (!iso) return '—'; var s = String(iso); return esc(s.slice(0, 10) + ' ' + s.slice(11, 16)); }
  function mb(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1000) + ' kB'; }
  function say(id, text, kind) { var e = $(id); if (e) { e.textContent = text || ''; e.setAttribute('data-kind', kind || ''); } }
  function errText(e) { var i = I(); return i ? i.cloudErrText(e) : String((e && e.code) || e); }

  var view = { trash: false, filter: '', projects: [], me: null, root: null };

  // ── render ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  function render(body) {
    if (!body) return false;
    var a = A();
    var st = a ? a.state() : { status: 'signedOut' };
    body.innerHTML = '<div id="acct_root">' + (st.status === 'signedIn' ? signedInHtml(st) : signedOutHtml(st)) + helpHtml() + '</div>';
    view.root = $('acct_root');
    wire(st);
    return true;
  }
  function outageNote() {
    var c = C(); var s = c ? c.status() : {};
    return 'Cloud unavailable — your work is saved on this device.' + (s.lastSyncAt ? ' Last cloud save ' + new Date(s.lastSyncAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC.' : '');
  }
  function signedOutHtml(st) {
    var msg = st.status === 'unavailable' ? (st.reason === 'paused' ? 'Cloud sync is paused right now. Your work is saved on this device.' : outageNote())
      : 'Sign in to keep your projects in your own cloud database and open them on any computer. Without signing in, nothing leaves this device.';
    return '<div class="card"><div class="card-title">Account</div><p id="acct_page_status">' + esc(msg) + '</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-primary" id="acct_page_signin">' + (st.status === 'unavailable' ? 'Try again' : 'Sign in') + '</button></div></div>';
  }
  function signedInHtml(st) {
    var me = st.me || {}; var u = me.user || st.user || {}; var s = me.session || {};
    var how = s.authMethod === 'google' ? 'Google' : s.authMethod === 'linkedin' ? 'LinkedIn' : s.authMethod === 'passkey' ? 'a passkey' : 'an e-mail code';
    var q = me.quota || { limit: 0, used: 0 };
    var pct = q.limit ? Math.min(100, Math.round(100 * q.used / q.limit)) : 0;
    return '' +
      '<div class="card" id="acct_card_profile"><div class="card-title">Profile and security</div>' +
      '<div class="rrow"><span class="rl">E-mail address</span><span class="rv" id="acct_p_email">' + esc(u.emailMasked) + '</span></div>' +
      (u.recoveryMasked ? '<div class="rrow"><span class="rl">Recovery address</span><span class="rv" id="acct_p_recovery">' + esc(u.recoveryMasked) + '</span></div>' : '') +
      '<div class="rrow"><span class="rl">This session</span><span class="rv">signed in with ' + esc(how) + ' on ' + when(s.authAt) + (s.publicDevice ? ' (public computer)' : '') + '</span></div>' +
      '<div class="rrow"><span class="rl">Account created</span><span class="rv">' + day(u.created) + '</span></div>' +
      '<div class="rrow"><span class="rl">Terms / Privacy versions</span><span class="rv">' + esc(u.terms) + ' / ' + esc(u.privacy) + '</span></div>' +
      (u.status === 'deleting' ? '<div id="acct_p_deleting">&#9888; Your account is being deleted on ' + day(u.deleteAt) + '. <button type="button" class="btn btn-primary" id="acct_cancel_delete">Cancel deletion</button></div>' : '') +
      '<div class="fg-item"><label for="acct_new_email">Change e-mail address</label><input type="email" id="acct_new_email" maxlength="254" autocomplete="off" data-acct-skip="1"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_change_email">Send a code to the new address</button></div>' +
      '<div class="fg-item" id="acct_email_code_row" hidden><label for="acct_email_code">Code from the new address</label><input type="text" id="acct_email_code" inputmode="numeric" maxlength="11" autocomplete="one-time-code"></div>' +
      '<div class="acct-btns" id="acct_email_confirm_row" hidden><button type="button" class="btn btn-primary" id="acct_confirm_email">Confirm the new address</button></div>' +
      '<div class="fg-item"><label for="acct_recovery">' + (u.recoveryMasked ? 'Replace the recovery address' : 'Add a recovery address (a personal address helps if you lose your work mailbox)') + '</label><input type="email" id="acct_recovery" maxlength="254" autocomplete="off"></div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_set_recovery">Send a code to it</button>' +
      (u.recoveryMasked ? '<button type="button" class="btn btn-secondary" id="acct_remove_recovery">Remove the recovery address</button>' : '') + '</div>' +
      '<div class="fg-item" id="acct_recovery_code_row" hidden><label for="acct_recovery_code">Code from the recovery address</label><input type="text" id="acct_recovery_code" inputmode="numeric" maxlength="11"></div>' +
      '<div class="acct-btns" id="acct_recovery_confirm_row" hidden><button type="button" class="btn btn-primary" id="acct_confirm_recovery">Confirm the recovery address</button></div>' +
      '<div id="acct_profile_msg" role="status" aria-live="polite"></div></div>' +

      '<div class="card" id="acct_card_projects"><div class="card-title">Cloud projects</div>' +
      '<div class="acct-btns"><input type="text" id="acct_filter" placeholder="Filter by name, client or well" aria-label="Filter projects" data-acct-skip="1">' +
      '<button type="button" class="btn btn-secondary" id="acct_toggle_trash">' + (view.trash ? 'Show projects' : 'Show trash') + '</button>' +
      '<button type="button" class="btn btn-secondary" id="acct_import">Import files…</button>' +
      '<button type="button" class="btn btn-primary" id="acct_save_new">Save this device\'s project to the cloud</button></div>' +
      '<div id="acct_projects" aria-live="polite"><p>Loading…</p></div><div id="acct_projects_msg" role="status" aria-live="polite"></div></div>' +

      '<div class="card" id="acct_card_devices"><div class="card-title">Devices</div><div id="acct_devices">' + devicesHtml(me.devices || []) + '</div>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_signout_all">Sign out everywhere…</button></div><div id="acct_devices_msg" role="status"></div></div>' +

      // WP-O mount point: the Sign-in methods card (e-mail, recovery, Google, LinkedIn, passkeys; link / unlink)
      '<div class="card" id="acct_methods_card" data-owner="WP-O"><div class="card-title">Sign-in methods</div>' +
      '<div class="rrow"><span class="rl">E-mail code</span><span class="rv">always on — ' + esc(u.emailMasked) + '</span></div>' +
      '<div id="acct_methods_mount"></div>' +
      '<p class="acct-note">Your e-mail address always works as a way in, even if you lose your Google or LinkedIn account.</p></div>' +

      '<div class="card" id="acct_card_local"><div class="card-title">On this device</div><div id="acct_local"><p>Loading…</p></div></div>' +

      '<div class="card" id="acct_card_storage"><div class="card-title">Storage</div>' +
      '<div class="rrow"><span class="rl">Used</span><span class="rv" id="acct_storage_used">' + mb(q.used) + ' of ' + mb(q.limit) + ' (' + pct + ' %)</span></div>' +
      '<div style="height:8px;background:var(--bg3,#333);border-radius:4px;overflow:hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Cloud storage used">' +
      '<div style="height:8px;width:' + pct + '%;background:' + (pct >= 90 ? '#d9483b' : '#2fa84f') + '"></div></div></div>' +

      '<div class="card" id="acct_card_data"><div class="card-title">Your data</div>' +
      '<p>Export everything: a zip file with every cloud project as a .h2oilproj file and your account data (devices, sign-in methods, activity).</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_export">Export everything</button></div>' +
      '<p>Delete account: everything is hidden at once and deleted for good after 7 days. Signing in again during those days lets you cancel.</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_delete">Delete account…</button></div><div id="acct_data_msg" role="status" aria-live="polite"></div></div>' +

      '<div class="card" id="acct_card_activity"><div class="card-title">Activity</div><p>Your own sign-ins and security changes are listed in Export everything (12 months).</p>' +
      '<div class="acct-btns"><button type="button" class="btn btn-secondary" id="acct_show_activity">Show my activity</button></div><div id="acct_activity"></div></div>';
  }
  function devicesHtml(list) {
    if (!list.length) return '<p>No devices.</p>';
    return '<table class="dtable" id="acct_devices_table"><thead><tr><th>Device</th><th>Last seen</th><th></th></tr></thead><tbody>' +
      list.map(function (d) {
        return '<tr data-id="' + esc(d.id) + '"><td>' + esc(d.label || 'Device') + (d.current ? ' <b>(this device)</b>' : '') + '</td><td>' + when(d.lastSeen) + '</td><td>' +
          '<button type="button" class="btn btn-secondary acct-dev-rename" data-id="' + esc(d.id) + '">Rename</button> ' +
          (d.current ? '' : '<button type="button" class="btn btn-secondary acct-dev-revoke" data-id="' + esc(d.id) + '">Sign out device</button>') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function projectsHtml(list) {
    var f = view.filter.toLowerCase();
    var rows = list.filter(function (p) {
      if (!f) return true;
      var m = p.meta || {};
      return [p.name, m.client, m.well, m.field].join(' ').toLowerCase().indexOf(f) !== -1;
    });
    if (!rows.length) return '<p id="acct_projects_empty">' + (view.trash ? 'The trash is empty.' : (list.length ? 'No project matches the filter.' : 'No cloud projects yet. Use Save to cloud, or import project files.')) + '</p>';
    var c = C(); var bound = c ? c.status().projectId : null;
    return '<table class="dtable" id="acct_projects_table"><thead><tr><th>Name</th><th>Client / well</th><th>Wells</th><th>Last saved</th><th>Size</th><th></th></tr></thead><tbody>' +
      rows.map(function (p) {
        var m = p.meta || {};
        var acts = view.trash
          ? '<button type="button" class="btn btn-secondary" data-act="restore" data-id="' + esc(p.id) + '">Restore</button> <button type="button" class="btn btn-secondary" data-act="purge" data-id="' + esc(p.id) + '">Delete for ever</button>'
          : ['open:Open', 'rename:Rename', 'duplicate:Duplicate', 'history:History', 'download:Download', 'trash:Move to trash'].map(function (x) {
            var k = x.split(':'); return '<button type="button" class="btn btn-secondary" data-act="' + k[0] + '" data-id="' + esc(p.id) + '">' + k[1] + '</button>';
          }).join(' ');
        return '<tr data-id="' + esc(p.id) + '"><td>' + esc(p.name) + (p.conflictOf ? ' <span title="conflict copy">&#9888; conflict copy</span>' : '') + (p.id === bound ? ' <b>(open here)</b>' : '') + '</td>' +
          '<td>' + esc([m.client, m.well].filter(Boolean).join(' / ')) + '</td><td>' + esc(p.wells) + '</td><td>' + when(p.savedAt) + '</td><td>' + mb(p.bytes) + '</td><td>' + acts + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function helpHtml() {
    return '<div class="card" id="acct_card_help"><div class="card-title">Help: accounts and cloud projects</div>' +
      '<p><b>How cloud projects work.</b> Your work is always saved on this device first. <i>Save to cloud</i> (the &#9729; button, the account menu or Ctrl+S while a cloud project is open) ' +
      'stores a new version of the project in your own cloud database; <i>Open from cloud</i> loads a version on any computer. Every save is kept in the project\'s history, so you can restore an older version.</p>' +
      '<p><b>Two computers.</b> If the cloud copy changed on another computer since you opened it, Save to cloud asks: overwrite it (the other version stays in the history), save yours as a new project, or cancel. Nothing is overwritten silently.</p>' +
      '<p><b>Public or shared computers.</b> Tick "This is a public or shared computer" when you sign in. You are signed out after 12 hours, and signing out removes your work from the browser. ' +
      'Changes that are not in the cloud yet can be uploaded, downloaded or kept locked for 7 days so that only you can unlock them.</p>' +
      '<p><b>Didn\'t get the code?</b> Look in your spam or quarantine folder, ask your IT team to allow no-reply@h2oil.co.uk, and remember that codes last 15 minutes and the previous code still works after "Send again". A recovery address can receive the code too.</p>' +
      '<p><b>Your data.</b> Export everything at any time; deleting the account hides everything at once and removes it after 7 days. For other requests write to software@h2oil.co.uk.</p></div>';
  }

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  function on(id, fn) { var e = $(id); if (e) e.addEventListener('click', fn); }
  function wire(st) {
    var a = A();
    if (st.status !== 'signedIn') {
      on('acct_page_signin', function () {
        if (st.status === 'unavailable') a.refresh().then(rerender, rerender);
        else a.openSignIn().then(function (s) { if (s) rerender(); });
      });
      return;
    }
    var root = view.root;
    on('acct_change_email', function () {
      var v = String($('acct_new_email').value || '').trim();
      if (!v) { say('acct_profile_msg', 'Type the new address first.', 'err'); return; }
      a.changeEmail(v).then(function () {
        $('acct_email_code_row').hidden = false; $('acct_email_confirm_row').hidden = false;
        say('acct_profile_msg', 'If the address can be used, a code is on its way to it.', 'ok');
      }, function (e) { if (e && e.code !== 'cancelled') say('acct_profile_msg', errText(e), 'err'); });
    });
    on('acct_confirm_email', function () {
      a.confirmEmail(String($('acct_email_code').value || '').replace(/\s/g, '')).then(function () { rerender(); }, function (e) { say('acct_profile_msg', e && e.code === 'invalid_or_expired' ? 'That code is wrong or has expired.' : errText(e), 'err'); });
    });
    on('acct_set_recovery', function () {
      var v = String($('acct_recovery').value || '').trim();
      if (!v) { say('acct_profile_msg', 'Type the recovery address first.', 'err'); return; }
      a.setRecovery(v).then(function () {
        $('acct_recovery_code_row').hidden = false; $('acct_recovery_confirm_row').hidden = false;
        say('acct_profile_msg', 'If the address can be used, a code is on its way to it.', 'ok');
      }, function (e) { if (e && e.code !== 'cancelled') say('acct_profile_msg', errText(e), 'err'); });
    });
    on('acct_confirm_recovery', function () {
      a.confirmRecovery(String($('acct_recovery_code').value || '').replace(/\s/g, '')).then(function () { rerender(); }, function (e) { say('acct_profile_msg', e && e.code === 'invalid_or_expired' ? 'That code is wrong or has expired.' : errText(e), 'err'); });
    });
    on('acct_remove_recovery', function () { a.removeRecovery().then(rerender, function (e) { if (e && e.code !== 'cancelled') say('acct_profile_msg', errText(e), 'err'); }); });
    on('acct_cancel_delete', function () { a.cancelDeletion().then(rerender, function (e) { say('acct_profile_msg', errText(e), 'err'); }); });
    var filt = $('acct_filter');
    if (filt) filt.addEventListener('input', function () { view.filter = String(filt.value || ''); drawProjects(); });
    on('acct_toggle_trash', function () { view.trash = !view.trash; $('acct_toggle_trash').textContent = view.trash ? 'Show projects' : 'Show trash'; loadProjects(); });
    on('acct_import', function () { C().pickAndImport().then(function () { loadProjects(); }, function (e) { say('acct_projects_msg', errText(e), 'err'); }); });
    on('acct_save_new', function () { C().saveToCloud({ as: true }).then(function (r) { if (r && !r.cancelled) say('acct_projects_msg', 'Saved to the cloud.', 'ok'); loadProjects(); }, function (e) { say('acct_projects_msg', errText(e), 'err'); }); });
    var pj = $('acct_projects');
    if (pj) pj.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!t) return;
      projectAction(t.getAttribute('data-act'), t.getAttribute('data-id'));
    });
    var dv = $('acct_devices');
    if (dv) dv.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('button') : null; if (!t) return;
      var id = t.getAttribute('data-id');
      if (/acct-dev-rename/.test(t.className)) {
        var nm = G.prompt ? G.prompt('Device name (letters, digits, spaces and - _ . ( ) only):', '') : null;
        if (nm == null) return;
        nm = String(nm).replace(/[^A-Za-z0-9 _.()-]/g, '').slice(0, 40);
        a.call('POST', '/devices/rename', { id: id, label: nm }).then(function () { return a.refresh(); }).then(rerender, function (e) { say('acct_devices_msg', errText(e), 'err'); });
      } else if (/acct-dev-revoke/.test(t.className)) {
        a.call('POST', '/devices/revoke', { id: id }).then(function () { return a.refresh(); }).then(rerender, function (e) { say('acct_devices_msg', errText(e), 'err'); });
      }
    });
    on('acct_signout_all', function () { signOutAll(); });
    on('acct_export', exportEverything);
    on('acct_delete', deleteAccount);
    on('acct_show_activity', showActivity);
    // WP-O: the Sign-in methods card
    var mm = $('acct_methods_mount');
    if (mm && typeof hooks.renderMethods === 'function') { try { hooks.renderMethods(mm, st); } catch (e) { /* WP-O */ } }
    loadProjects(); drawLocal();
    return root;
  }
  function signOutAll() {
    var i = I();
    return i.choose({ title: 'Sign out everywhere', text: 'Sign out of every browser and device that uses your account? This one is signed out too.',
      html: '<label class="acct-tick"><input type="checkbox" id="acct_recent_methods"> Also remove passkeys and Google / LinkedIn links added in the last 14 days</label>',
      buttons: [{ id: 'all', label: 'Sign out everywhere', primary: true }, { id: 'cancel', label: 'Cancel' }], keepOpen: true }).then(function (c) {
      var t = $('acct_recent_methods'); var recent = !!(t && t.checked);
      i.closeDialog(false);
      if (c !== 'all') return null;
      return A().signOut({ everywhere: true, alsoRecentMethodsDays: recent ? 14 : 0, keep: true }).then(rerender);
    });
  }
  function rerender() { var b = $('pgBody'); var r = $('acct_root'); render(r && r.parentNode ? r.parentNode : b); }
  function loadProjects() {
    var c = C(); if (!c) return Promise.resolve([]);
    return c.listProjects({ trash: view.trash }).then(function (list) { view.projects = list; drawProjects(); return list; }, function (e) {
      var pj = $('acct_projects');
      if (pj) pj.innerHTML = '<p id="acct_projects_outage">' + esc(I() && I().isOutage(e) ? outageNote() : errText(e)) + '</p>';
      return [];
    });
  }
  function drawProjects() { var pj = $('acct_projects'); if (pj) pj.innerHTML = projectsHtml(view.projects); }
  function projectAction(act, id) {
    var c = C(); var i = I();
    var p = view.projects.filter(function (x) { return x.id === id; })[0] || { id: id, name: '' };
    var done = function (text) { say('acct_projects_msg', text, 'ok'); return loadProjects(); };
    var bad = function (e) { if (e && e.code === 'cancelled') return; say('acct_projects_msg', errText(e), 'err'); };
    if (act === 'open') return c.openFromCloud(id).then(function () { done('Opened "' + p.name + '".'); }, bad);
    if (act === 'rename') {
      var nm = G.prompt ? G.prompt('New name for the project:', p.name) : null;
      if (nm == null || !String(nm).trim()) return null;
      return c.rename(id, String(nm).trim().slice(0, 200)).then(function () { done('Renamed.'); }, bad);
    }
    if (act === 'duplicate') return c.duplicate(id, ('Copy of ' + p.name).slice(0, 200)).then(function () { done('Duplicated.'); }, bad);
    if (act === 'download') return c.download(id, p.name).then(function () { done('Downloaded.'); }, bad);
    if (act === 'trash') return c.trash(id).then(function () { done('Moved to the trash (kept for 30 days).'); }, bad);
    if (act === 'restore') return c.restore(id).then(function () { done('Restored.'); }, bad);
    if (act === 'purge') {
      return i.choose({ title: 'Delete for ever', text: 'Delete "' + p.name + '" and its whole history for good? This cannot be undone.',
        buttons: [{ id: 'yes', label: 'Delete for ever' }, { id: 'no', label: 'Cancel', primary: true }] }).then(function (ch) {
        if (ch !== 'yes') return null;
        return c.purge(id).then(function () { done('Deleted for good.'); }, bad);
      });
    }
    if (act === 'history') {
      return c.history(id).then(function (revs) {
        var btns = revs.slice(0, 12).map(function (r) { return { id: 'r' + r.rev, label: 'Restore version ' + r.rev + ' (' + String(r.savedAt).slice(0, 16).replace('T', ' ') + ', ' + r.reason + ')' }; });
        btns.push({ id: 'close', label: 'Close', primary: true });
        return i.choose({ title: 'History of "' + p.name + '"', text: 'Restoring a version makes it the newest version; nothing is removed from the history.', buttons: btns }).then(function (ch) {
          if (!ch || ch.charAt(0) !== 'r') return null;
          return c.restoreRevision(id, Number(ch.slice(1))).then(function (r) { done('Version restored as version ' + r.rev + '.'); }, bad);
        });
      }, bad);
    }
    return null;
  }
  function drawLocal() {
    var c = C(); var el = $('acct_local'); if (!c || !el) return Promise.resolve();
    return Promise.all([c.local.preAccount(), c.local.stash()]).then(function (r) {
      var pre = r[0], st = r[1] || {};
      var rows = [];
      if (pre) rows.push('<div class="rrow"><span class="rl">Work from before you signed in (' + day(new Date(pre.at).toISOString()) + ')</span><span class="rv">' +
        '<button type="button" class="btn btn-secondary" id="acct_pre_restore">Restore</button> <button type="button" class="btn btn-secondary" id="acct_pre_discard">Discard</button></span></div>');
      Object.keys(st).forEach(function (k, n) {
        rows.push('<div class="rrow"><span class="rl">Work kept local at a hand-over (' + day(new Date(st[k].at).toISOString()) + ')</span><span class="rv">' +
          '<button type="button" class="btn btn-secondary acct-stash" data-act="restore" data-owner="' + esc(k) + '" id="acct_stash_restore_' + n + '">Restore</button> ' +
          '<button type="button" class="btn btn-secondary acct-stash" data-act="discard" data-owner="' + esc(k) + '" id="acct_stash_discard_' + n + '">Discard</button></span></div>');
      });
      el.innerHTML = rows.length ? rows.join('') : '<p id="acct_local_none">Nothing is kept on this device besides the open project.</p>';
      on('acct_pre_restore', function () { c.local.restorePreAccount().then(drawLocal); });
      on('acct_pre_discard', function () { c.local.discardPreAccount().then(drawLocal); });
      el.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('button.acct-stash') : null; if (!t) return;
        var o = t.getAttribute('data-owner');
        (t.getAttribute('data-act') === 'restore' ? c.local.restoreStash(o) : c.local.discardStash(o)).then(drawLocal);
      });
    });
  }

  // ── export (zip, store only; split above 200 MB) and delete ─────────────────────────────────────────────────────────
  var CRC = null;
  function crc32(b) {
    if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    var x = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) x = CRC[(x ^ b[i]) & 0xFF] ^ (x >>> 8);
    return (x ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new G.TextEncoder().encode(s); }
  // zip(files [{name, text}]) → Uint8Array (stored entries, UTF-8 names)
  function zip(files) {
    var parts = [], central = [], off = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = utf8(f.name), data = utf8(f.text), crc = crc32(data);
      var head = [].concat([0x50, 0x4b, 3, 4], u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      central.push(new Uint8Array([].concat([0x50, 0x4b, 1, 2], u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), name);
      off += head.length + name.length + data.length;
    });
    var cdSize = central.reduce(function (n, x) { return n + x.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4b, 5, 6], u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(off), u16(0)));
    var all = parts.concat(central, [end]);
    var n = all.reduce(function (s, x) { return s + x.length; }, 0), out = new Uint8Array(n), o = 0;
    all.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }
  // splitFiles(files, limit) → [[files]] — groups of at most `limit` bytes (account.json in the first)
  function splitFiles(files, limit) {
    var groups = [[]], size = 0;
    files.forEach(function (f) {
      var n = utf8(f.text).length + f.name.length + 100;
      if (groups[groups.length - 1].length && size + n > limit) { groups.push([]); size = 0; }
      groups[groups.length - 1].push(f); size += n;
    });
    return groups;
  }
  function downloadBytes(name, bytes) {
    if (!HAS_DOC) return;
    var blob = new G.Blob([bytes], { type: 'application/zip' });
    var url = null; try { url = G.URL.createObjectURL(blob); } catch (e) { url = null; }
    var a = document.createElement('a'); a.href = url || '#'; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); try { document.body.removeChild(a); } catch (e) { /* gone */ }
  }
  function exportEverything(limit) {
    var c = C();
    say('acct_data_msg', 'Preparing the export…');
    return c.exportAll().then(function (res) {
      var groups = splitFiles(res.files, typeof limit === 'number' ? limit : ZIP_SPLIT);
      var stamp = new Date().toISOString().slice(0, 10);
      groups.forEach(function (g, k) { downloadBytes('well-testing-suite-export-' + stamp + (groups.length > 1 ? '-part' + (k + 1) : '') + '.zip', zip(g)); });
      say('acct_data_msg', 'Export ready: ' + res.files.length + ' files in ' + groups.length + ' zip file' + (groups.length > 1 ? 's' : '') + '.', 'ok');
      return { files: res.files.length, zips: groups.length, account: res.account };
    }, function (e) { if (!e || e.code !== 'cancelled') say('acct_data_msg', errText(e), 'err'); return null; });
  }
  function deleteAccount() {
    var i = I(); var a = A();
    return i.choose({ title: 'Delete account', text: 'Your account and every cloud project are hidden at once and deleted for good after 7 days. Your work on this device stays. Type DELETE to confirm.',
      html: '<label for="acct_delete_confirm">Type DELETE</label><input type="text" id="acct_delete_confirm" autocomplete="off" maxlength="10">',
      buttons: [{ id: 'delete', label: 'Delete my account' }, { id: 'cancel', label: 'Cancel', primary: true }], keepOpen: true }).then(function (ch) {
      var v = $('acct_delete_confirm'); var typed = v ? String(v.value || '').trim() : '';
      i.closeDialog(false);
      if (ch !== 'delete') return null;
      if (typed !== 'DELETE') { say('acct_data_msg', 'Type DELETE in capitals to confirm.', 'err'); return null; }
      return a.withStepUp(function () { return a.call('POST', '/account/delete', { confirm: 'DELETE' }); }, 'Deleting your account needs a fresh confirmation.').then(function (r) {
        say('acct_data_msg', 'Your account will be deleted on ' + String(r.json.deleteAt).slice(0, 10) + '. Sign in before then to cancel.', 'ok');
        return a._i.signedOutLocal('deleted').then(function () { rerender(); return r.json; });
      }, function (e) { if (!e || e.code !== 'cancelled') say('acct_data_msg', errText(e), 'err'); return null; });
    });
  }
  function showActivity() {
    var c = C();
    return c.exportAll().then(function (res) {
      var rows = (res.account.audit || []).slice(-90);
      var el = $('acct_activity');
      if (el) el.innerHTML = rows.length ? '<table class="dtable" id="acct_activity_table"><thead><tr><th>When</th><th>What</th></tr></thead><tbody>' +
        rows.map(function (r) { return '<tr><td>' + when(r.at) + '</td><td>' + esc(r.action) + (r.detail && r.detail.method ? ' (' + esc(r.detail.method) + ')' : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<p>No activity.</p>';
      return rows.length;
    }, function (e) { if (!e || e.code !== 'cancelled') say('acct_data_msg', errText(e), 'err'); return 0; });
  }

  // ── registry ───────────────────────────────────────────────────────────────────────────────────────────────────────
  var entry = {
    key: 'account', title: 'Account', sub: 'Sign-in, cloud projects and your data', group: 'Overview', icon: '&#9729;',
    navHidden: true, render: render,
  };
  var registered = false;
  // register({force}) → true once the entry is in WTS_calcRegistry: only with the beta flag and a host that has the account
  // hooks (H7 navHidden lands with H8's ACCT-marked #wts_account_host), unless forced (tests).
  function register(o) {
    o = o || {};
    if (registered) return true;
    var a = A();
    var hostReady = HAS_DOC && !!document.getElementById('wts_account_host') && !document.getElementById('wts_account_host').getAttribute('data-acct-created');
    if (!o.force && !(a && a.betaEnabled && a.betaEnabled() && hostReady)) return false;
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.account = entry;
    registered = true;
    return true;
  }
  function open() {
    if (registered && typeof G.WTS_nav === 'function') return G.WTS_nav('account');
    var b = $('pgBody'); if (!b) return null;
    var t = $('pgTitle'), s = $('pgSub'); if (t) t.textContent = entry.title; if (s) s.textContent = entry.sub;
    return render(b);
  }
  G.WTS_accountPage = { VERSION: VERSION, entry: entry, render: render, register: register, open: open, hooks: hooks,
    _zip: zip, _splitFiles: splitFiles, _export: exportEverything, _reload: loadProjects };
  register();
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var P = G.WTS_accountPage;
  if (P && P.entry && P.entry.navHidden !== true) throw new Error('68 self-test: the account page must be navHidden');
})();
