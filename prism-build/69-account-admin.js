// ── ACCT:START — web only; sync-from-main.js strips this block ──
// prism-build/69-account-admin.js — the `admin` page: who has signed up, from where and how (owner only). Round-10.
//
// Same guard as 66 / 68; outside it nothing is defined. The registry entry has navHidden:true (a route, no sidebar button, no
// home tile), registered only with the invite-beta flag on a host that carries the account hooks, like the account page. The
// page shows its content only when GET /me says admin:true (the server decides: WTS_ADMIN_EMAILS); anyone else — signed out,
// a normal account, or the server answering 404 not_found — sees "Not available". It is opened from the account chip menu
// ("Admin dashboard"), the account page, or a load with #admin.
//
// API (server/, shared contract): GET /admin/summary, GET /admin/users?limit&cursor&q, GET / POST /admin/invites. Every server
// string is escaped before it reaches innerHTML. Plain .card / .kpi / table.dtable / canvas-in-.chart-wrap markup; the route is
// in the host skip tables (no autosave, no report snapshot, no recent tile, no page-export bar) and the root carries
// data-acct-skip, so nothing typed here (search, invite address) is ever stored. No timers, polling or function wrapping.
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
  var PAGE = 50;
  function A() { return G.WTS_account || null; }
  function I() { var a = A(); return a && a._i ? a._i : null; }
  function $(id) { return HAS_DOC ? document.getElementById(id) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function int(n) { return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function day(iso) { return iso ? esc(String(iso).slice(0, 10)) : '—'; }
  function when(iso) { if (!iso) return '—'; var s = String(iso); return esc(s.slice(0, 10) + ' ' + s.slice(11, 16)); }
  function bytes(n) {
    n = num(n);
    var t = n >= 1e9 ? (Math.round(n / 1e8) / 10) + ' GB' : n >= 1e6 ? (Math.round(n / 1e5) / 10) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : Math.round(n) + ' B';
    var dc = false; try { dc = !!(G.WTS_a11y && G.WTS_a11y.decimalComma && G.WTS_a11y.decimalComma()); } catch (e) { /* none */ }
    return dc ? t.replace('.', ',') : t;
  }
  function isAdmin() { var a = A(); return !!(a && typeof a.isAdmin === 'function' && a.isAdmin()); }
  function say(id, text, kind) { var e = $(id); if (e) { e.textContent = text || ''; e.setAttribute('data-kind', kind || ''); } }
  function errText(e) {
    if (e && e.code === 'not_found') return 'Not available.';
    var i = I(); return i && i.cloudErrText ? i.cloudErrText(e) : 'Something went wrong (' + String((e && e.code) || 'error') + ').';
  }

  // ── countries ──────────────────────────────────────────────────────────────────────────────────────────────────────
  var regionNames = null;
  try { if (G.Intl && typeof G.Intl.DisplayNames === 'function') regionNames = new G.Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { regionNames = null; }
  function cc(code) { var c = String(code == null ? '' : code).toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : null; }
  function countryName(code) {
    var c = cc(code); if (!c) return 'Unknown';
    var n = null; try { n = regionNames ? regionNames.of(c) : null; } catch (e) { n = null; }
    return n && n !== c ? n : c;
  }
  // the flag emoji of an ISO 3166-1 alpha-2 code (two regional indicator symbols); an unknown country gets a white flag
  function flag(code) {
    var c = cc(code); if (!c) return '🏳';
    try { return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65); } catch (e) { return ''; }
  }
  var METHOD = { code: 'E-mail code', google: 'Google', linkedin: 'LinkedIn' };
  function methodName(m) { return METHOD[m] || String(m || '—'); }

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  var view = { summary: null, users: [], next: null, q: '', loading: false, invites: null };

  // ── render ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  function ensureCss() {
    var i = I(); if (i && i.ensureCss) i.ensureCss();
    if (!HAS_DOC || $('adm_css')) return;
    var st = document.createElement('style'); st.id = 'adm_css';
    st.textContent = [
      '#adm_root .adm-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-top:8px}',
      '#adm_root .kpi{background:var(--bg1,#0d1117);border:1px solid var(--border,#30363d);border-radius:8px;padding:10px 12px}',
      '#adm_root .kpi-l{font-size:10px;color:var(--text3,#999);text-transform:uppercase;letter-spacing:.5px;font-weight:700}',
      '#adm_root .kpi-v{font-size:20px;font-weight:700;margin-top:4px;color:var(--text,#eee)}',
      '#adm_root .adm-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}',
      '#adm_root .adm-bar input{flex:1 1 220px;min-width:0;font-size:14px;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#555);background:var(--bg,#111);color:var(--text,#eee)}',
      '#adm_root .adm-sub{font-size:12px;color:var(--text3,#999)}#adm_root p.adm-sub{margin:4px 0 10px}',
      '#adm_root .adm-flag{font-size:16px;margin-right:6px}',
      '#adm_root .adm-share{display:inline-block;height:6px;background:var(--accent,#f0883e);border-radius:3px;vertical-align:middle;margin-right:6px}',
      '#adm_root .adm-msg[data-kind=err]{color:#ff8a80}#adm_root .adm-msg[data-kind=ok]{color:#8bd48b}',
      '#adm_root .adm-scroll{overflow-x:auto}#adm_root [hidden]{display:none!important}#adm_root td.adm-nw{white-space:nowrap}',
      '#adm_root .fg-grid2 label{display:block;font-size:12px;font-weight:600;color:var(--text2,#bbb);margin:0 0 4px}',
      '#adm_root .fg-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '#adm_root .fg-grid2 input{width:100%;box-sizing:border-box;font-size:14px;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#555);background:var(--bg,#111);color:var(--text,#eee)}',
      '@media (max-width:600px){#adm_root .fg-grid2{grid-template-columns:1fr}#adm_root .adm-bar .btn{flex:1 1 100%;min-height:44px}',
      '#adm_root table.dtable thead{display:none}#adm_root table.dtable,#adm_root table.dtable tbody,#adm_root table.dtable tr,#adm_root table.dtable td{display:block;width:100%;box-sizing:border-box}',
      '#adm_root table.dtable tr{border-bottom:1px solid var(--border,#444);padding:6px 0}#adm_root table.dtable td{border:0;padding:2px 0}',
      '#adm_root table.dtable td[data-label]:before{content:attr(data-label) ": ";color:var(--text3,#999);font-size:11px}}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function render(body) {
    if (!body) return false;
    ensureCss();
    if (!isAdmin()) {
      body.innerHTML = '<div id="adm_root" data-acct-skip="1"><div class="card"><div class="card-title">Admin dashboard</div>' +
        '<p id="adm_na">Not available.</p></div></div>';
      view.summary = null; view.users = []; view.next = null; view.invites = null;
      return true;
    }
    body.innerHTML = '<div id="adm_root" data-acct-skip="1">' +
      '<div class="card" id="adm_card_overview"><div class="card-title">Overview</div>' +
      '<div class="adm-bar"><button type="button" class="btn btn-secondary" id="adm_refresh">&#8635; Refresh</button>' +
      '<span class="adm-sub" id="adm_generated" aria-live="polite">Loading…</span></div>' +
      '<div class="adm-kpis" id="adm_kpis"></div><div id="adm_msg" class="adm-msg" role="status" aria-live="polite"></div></div>' +
      '<div class="card" id="adm_card_countries"><div class="card-title">Users by country</div><div id="adm_countries" class="adm-scroll"><p>Loading…</p></div>' +
      '<p class="adm-sub">Country of the last sign-in (from the hosting edge; no IP address is stored). Unknown = not sent or not valid.</p></div>' +
      '<div class="card" id="adm_card_signups"><div class="card-title">Sign-ups per day (last 90 days)</div>' +
      '<div class="chart-wrap"><canvas id="adm_chart" width="900" height="220" role="img" aria-label="Sign-ups per day, last 90 days"></canvas></div>' +
      '<p class="adm-sub" id="adm_signups_total"></p><div id="adm_methods" class="adm-sub"></div></div>' +
      '<div class="card" id="adm_card_users"><div class="card-title">Users</div>' +
      '<div class="adm-bar"><input type="search" id="adm_q" placeholder="Search by e-mail" aria-label="Search users by e-mail" maxlength="254" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="btn btn-secondary" id="adm_search">Search</button>' +
      '<button type="button" class="btn btn-secondary" id="adm_csv">Export CSV</button></div>' +
      '<div id="adm_users" class="adm-scroll"><p>Loading…</p></div>' +
      '<div class="adm-bar" style="margin-top:8px"><button type="button" class="btn btn-secondary" id="adm_more" hidden>Load more</button>' +
      '<span class="adm-sub" id="adm_users_count"></span></div><div id="adm_users_msg" class="adm-msg" role="status" aria-live="polite"></div></div>' +
      '<div class="card" id="adm_card_invite"><div class="card-title">Invite someone</div>' +
      '<p class="adm-sub">Adds the address to the sign-up list, so that person can create an account (sign-ups are by invitation). No e-mail is sent: tell them to sign up at welltest.h2oil.co.uk with this address.</p>' +
      '<div class="fg-grid2"><div><label for="adm_inv_email">E-mail address</label><input type="email" id="adm_inv_email" maxlength="254" autocomplete="off" spellcheck="false"></div>' +
      '<div><label for="adm_inv_note">Note (optional)</label><input type="text" id="adm_inv_note" maxlength="200" autocomplete="off"></div></div>' +
      '<div class="adm-bar" style="margin-top:10px"><button type="button" class="btn btn-primary" id="adm_inv_send">Add invitation</button></div>' +
      '<div id="adm_inv_msg" class="adm-msg" role="status" aria-live="polite"></div>' +
      '<div id="adm_invites" class="adm-scroll"></div></div>' +
      '</div>';
    wire();
    view.q = '';
    load();
    return true;
  }
  function wire() {
    var on = function (id, ev, fn) { var e = $(id); if (e) e.addEventListener(ev, fn); };
    on('adm_refresh', 'click', function () { load(); });
    on('adm_search', 'click', function () { search(); });
    on('adm_q', 'keydown', function (ev) { if (ev && ev.key === 'Enter') search(); });
    on('adm_more', 'click', function () { loadUsers(true); });
    on('adm_csv', 'click', function () { exportCsv(); });
    on('adm_inv_send', 'click', function () { invite(); });
    on('adm_inv_email', 'keydown', function (ev) { if (ev && ev.key === 'Enter') invite(); });
  }
  function search() { var q = $('adm_q'); view.q = q ? String(q.value || '').trim().slice(0, 254) : ''; return loadUsers(false); }

  // load() → Promise: summary, the first page of users and the invites, side by side
  function load() {
    say('adm_msg', '');
    return Promise.all([loadSummary(), loadUsers(false), loadInvites()]);
  }
  function loadSummary() {
    var a = A(); if (!a) return Promise.resolve(null);
    say('adm_generated', 'Loading…');
    return a.call('GET', '/admin/summary').then(function (r) {
      view.summary = (r && r.json) || {};
      drawSummary();
      return view.summary;
    }, function (e) { failed(e); return null; });
  }
  function failed(e) {
    if (e && e.code === 'not_found') {          // the server says this account is not an admin: show nothing else
      var root = $('adm_root'); if (root && root.parentNode) root.innerHTML = '<div class="card"><div class="card-title">Admin dashboard</div><p id="adm_na">Not available.</p></div>';
      return;
    }
    say('adm_msg', errText(e), 'err'); say('adm_generated', '');
  }
  function kpi(label, value, id) {
    return '<div class="kpi" id="' + id + '"><div class="kpi-l">' + esc(label) + '</div><div class="kpi-v">' + esc(value) + '</div></div>';
  }
  function drawSummary() {
    var s = view.summary || {}; var t = s.totals || {};
    var k = $('adm_kpis');
    if (k) k.innerHTML = kpi('Users', int(t.users), 'adm_k_users') + kpi('Active 7 days', int(t.active7d), 'adm_k_a7') +
      kpi('Active 30 days', int(t.active30d), 'adm_k_a30') + kpi('Cloud projects', int(t.projects), 'adm_k_projects') +
      kpi('Storage used', bytes(t.storageBytes), 'adm_k_storage') + kpi('Pending invitations', int(t.invitesPending), 'adm_k_invites');
    say('adm_generated', s.generatedAt ? 'Updated ' + String(s.generatedAt).slice(0, 16).replace('T', ' ') + ' UTC' : '');
    var c = $('adm_countries');
    var rows = Array.isArray(s.byCountry) ? s.byCountry.slice() : [];
    var total = rows.reduce(function (a, r) { return a + num(r && r.users); }, 0);
    if (c) c.innerHTML = rows.length ? '<table class="dtable" id="adm_countries_table"><thead><tr><th>Country</th><th>Users</th><th>Active 30 days</th><th>Share</th></tr></thead><tbody>' +
      rows.map(function (r) {
        r = r || {};
        var pct = total ? Math.round(1000 * num(r.users) / total) / 10 : 0;
        var code = cc(r.country);
        return '<tr data-country="' + esc(code || '') + '"><td data-label="Country"><span class="adm-flag" aria-hidden="true">' + esc(flag(code)) + '</span>' + esc(countryName(code)) +
          (code ? ' <span class="adm-sub">' + esc(code) + '</span>' : '') + '</td><td data-label="Users">' + int(r.users) + '</td><td data-label="Active 30 days">' + int(r.active30d) +
          '</td><td data-label="Share"><span class="adm-share" style="width:' + Math.max(2, Math.round(pct)) + 'px"></span>' + esc(String(pct)) + ' %</td></tr>';
      }).join('') + '</tbody></table>' : '<p>No users yet.</p>';
    var m = $('adm_methods');
    var ms = Array.isArray(s.byMethod) ? s.byMethod : [];
    if (m) m.textContent = ms.length ? 'Sign-in method: ' + ms.map(function (x) { return methodName(x && x.method) + ' ' + int(x && x.users); }).join(' · ') : '';
    drawChart();
  }
  // the last 90 days ending on the summary's day (UTC) → [{day, n}], every day present
  function days90() {
    var s = view.summary || {};
    var end = Date.parse(s.generatedAt || ''); if (!isFinite(end)) { var i = I(); end = i && i.now ? i.now() : Date.now(); }
    var map = {};
    (Array.isArray(s.signupsByDay) ? s.signupsByDay : []).forEach(function (d) { if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.day))) map[d.day] = num(d.n); });
    var out = [];
    for (var k = 89; k >= 0; k--) { var dd = new Date(end - k * 864e5).toISOString().slice(0, 10); out.push({ day: dd, n: map[dd] || 0 }); }
    return out;
  }
  function cssVar(name, dflt) {
    try { var v = G.getComputedStyle(document.documentElement).getPropertyValue(name); v = String(v || '').trim(); return v || dflt; } catch (e) { return dflt; }
  }
  function drawChart() {
    var cv = $('adm_chart'); if (!cv) return null;
    var data = days90();
    var tot = data.reduce(function (a, d) { return a + d.n; }, 0);
    say('adm_signups_total', int(tot) + ' sign-up' + (tot === 1 ? '' : 's') + ' in the last 90 days.');
    var ctx = null; try { ctx = cv.getContext ? cv.getContext('2d') : null; } catch (e) { ctx = null; }
    if (!ctx) return data;
    var dpr = Math.max(1, Math.min(3, Number(G.devicePixelRatio) || 1));
    var cssW = Math.max(280, Math.round((cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 900)));
    var cssH = 220;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    if (cv.style) cv.style.height = cssH + 'px';
    if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var txt = cssVar('--text3', '#8b949e'), grid = cssVar('--border', '#30363d'), bar = cssVar('--accent', '#f0883e');
    var pad = { l: 34, r: 10, t: 12, b: 26 };
    var w = cssW - pad.l - pad.r, h = cssH - pad.t - pad.b;
    var max = Math.max(1, data.reduce(function (a, d) { return Math.max(a, d.n); }, 0));
    var top = max <= 4 ? max : Math.ceil(max / 4) * 4;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = '11px sans-serif'; ctx.fillStyle = txt; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    var ticks = top <= 4 ? top : 4;
    for (var t = 0; t <= ticks; t++) {
      var v = Math.round(top * t / ticks), y = pad.t + h - h * v / top;
      ctx.beginPath(); ctx.moveTo(pad.l, Math.round(y) + 0.5); ctx.lineTo(pad.l + w, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillText(String(v), pad.l - 6, y);
    }
    var bw = w / data.length;
    ctx.fillStyle = bar;
    data.forEach(function (d, i) {
      if (!d.n) return;
      var bh = h * d.n / top;
      ctx.fillRect(pad.l + i * bw + bw * 0.15, pad.t + h - bh, Math.max(1, bw * 0.7), bh);
    });
    ctx.fillStyle = txt; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var j = 0; j < data.length; j += 15) ctx.fillText(data[j].day.slice(5), pad.l + j * bw + bw / 2, pad.t + h + 6);
    ctx.textAlign = 'right'; ctx.fillText(data[data.length - 1].day.slice(5), pad.l + w, pad.t + h + 6);
    return data;
  }

  // ── users ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function loadUsers(more) {
    var a = A(); if (!a) return Promise.resolve(null);
    if (view.loading) return Promise.resolve(null);
    if (more && !view.next) return Promise.resolve(null);
    view.loading = true;
    var qs = '?limit=' + PAGE + (more && view.next ? '&cursor=' + encodeURIComponent(view.next) : '') + (view.q ? '&q=' + encodeURIComponent(view.q) : '');
    var btn = $('adm_more'); if (btn) btn.disabled = true;
    say('adm_users_msg', more ? 'Loading more…' : '');
    return a.call('GET', '/admin/users' + qs).then(function (r) {
      view.loading = false;
      var j = (r && r.json) || {};
      var list = Array.isArray(j.users) ? j.users : [];
      view.users = more ? view.users.concat(list) : list;
      view.next = typeof j.next === 'string' && j.next ? j.next : null;
      say('adm_users_msg', '');
      drawUsers();
      return view.users;
    }, function (e) {
      view.loading = false;
      if (btn) btn.disabled = false;
      if (e && e.code === 'not_found') { failed(e); return null; }
      say('adm_users_msg', errText(e), 'err');
      return null;
    });
  }
  function place(u) {
    var c = cc(u.lastCountry) || cc(u.signupCountry);
    var city = u.lastCity ? String(u.lastCity) : '';
    if (!c && !city) return '—';
    return '<span class="adm-flag" aria-hidden="true">' + esc(flag(c)) + '</span>' + esc(countryName(c)) + (city ? ', ' + esc(city) : '') +
      (u.signupCountry && cc(u.signupCountry) && cc(u.signupCountry) !== cc(u.lastCountry) ? ' <span class="adm-sub">(signed up in ' + esc(cc(u.signupCountry)) + ')</span>' : '');
  }
  function drawUsers() {
    var el = $('adm_users'); if (!el) return;
    var list = view.users;
    el.innerHTML = list.length ? '<table class="dtable" id="adm_users_table"><thead><tr><th>E-mail</th><th>Method</th><th>Country / city</th><th>Joined</th><th>Last sign-in</th><th>Projects</th><th>Storage</th><th>Status</th></tr></thead><tbody>' +
      list.map(function (u) {
        u = u || {};
        return '<tr data-id="' + esc(u.id) + '"><td data-label="E-mail">' + esc(u.email) + '</td><td data-label="Method">' + esc(methodName(u.method)) + '</td>' +
          '<td data-label="Country / city">' + place(u) + '</td><td data-label="Joined" class="adm-nw">' + day(u.createdAt) + '</td><td data-label="Last sign-in" class="adm-nw">' + when(u.lastSignInAt) + '</td>' +
          '<td data-label="Projects">' + int(u.projects) + '</td><td data-label="Storage">' + esc(bytes(u.usedBytes)) + '</td><td data-label="Status">' + esc(u.status || '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p id="adm_users_empty">' + (view.q ? 'No user matches the search.' : 'No users yet.') + '</p>';
    var more = $('adm_more'); if (more) { more.hidden = !view.next; more.disabled = false; }
    say('adm_users_count', list.length ? list.length + ' user' + (list.length === 1 ? '' : 's') + ' shown' + (view.next ? ' (more available)' : '') : '');
  }
  // CSV of the users loaded so far (RFC 4180 quoting; a cell that starts with = + - @ is prefixed with ' so a spreadsheet
  // never runs it as a formula)
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv() {
    var head = ['email', 'method', 'status', 'createdAt', 'lastSignInAt', 'signupCountry', 'lastCountry', 'lastCity', 'projects', 'usedBytes'];
    return [head.join(',')].concat(view.users.map(function (u) {
      return head.map(function (k) { return csvCell(u ? u[k] : ''); }).join(',');
    })).join('\r\n') + '\r\n';
  }
  function exportCsv() {
    if (!view.users.length) { say('adm_users_msg', 'No users loaded yet.', 'err'); return null; }
    var text = csv();
    if (HAS_DOC && G.Blob && G.URL && typeof G.URL.createObjectURL === 'function') {
      var url = null; try { url = G.URL.createObjectURL(new G.Blob([text], { type: 'text/csv;charset=utf-8' })); } catch (e) { url = null; }
      var a = document.createElement('a'); a.href = url || '#'; a.download = 'wts-users-' + new Date().toISOString().slice(0, 10) + '.csv'; a.style.display = 'none';
      document.body.appendChild(a); try { a.click(); } catch (e) { /* none */ } try { document.body.removeChild(a); } catch (e) { /* gone */ }
      try { if (url && G.URL.revokeObjectURL) G.URL.revokeObjectURL(url); } catch (e) { /* none */ }
    }
    say('adm_users_msg', 'CSV of ' + view.users.length + ' user' + (view.users.length === 1 ? '' : 's') + ' downloaded.', 'ok');
    return text;
  }

  // ── invites ────────────────────────────────────────────────────────────────────────────────────────────────────────
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
  function invite() {
    var a = A(); if (!a) return Promise.resolve(false);
    var em = $('adm_inv_email'), nt = $('adm_inv_note');
    var email = em ? String(em.value || '').trim() : '';
    var note = nt ? String(nt.value || '').trim().slice(0, 200) : '';
    if (!EMAIL_RE.test(email) || email.length > 254) { say('adm_inv_msg', 'Enter one valid e-mail address.', 'err'); return Promise.resolve(false); }
    var btn = $('adm_inv_send'); if (btn) btn.disabled = true;
    say('adm_inv_msg', 'Adding…');
    return a.call('POST', '/admin/invites', note ? { email: email, note: note } : { email: email }).then(function () {
      if (btn) btn.disabled = false;
      if (em) em.value = ''; if (nt) nt.value = '';
      say('adm_inv_msg', 'Invitation added for ' + email + '. They can now create an account with this address.', 'ok');
      return Promise.all([loadInvites(), loadSummary()]).then(function () { return true; });
    }, function (e) {
      if (btn) btn.disabled = false;
      say('adm_inv_msg', e && e.code === 'bad_request' ? 'Enter one valid e-mail address.' : errText(e), 'err');
      return false;
    });
  }
  function loadInvites() {
    var a = A(); if (!a) return Promise.resolve(null);
    return a.call('GET', '/admin/invites').then(function (r) {
      var list = (r && r.json && Array.isArray(r.json.invites)) ? r.json.invites : [];
      view.invites = list;
      var el = $('adm_invites');
      if (el) el.innerHTML = list.length ? '<p class="adm-sub" style="margin-top:12px">Invitations on the list (addresses are stored only as a one-way hash, so they cannot be shown):</p>' +
        '<table class="dtable" id="adm_invites_table"><thead><tr><th>Added</th><th>Note</th></tr></thead><tbody>' +
        list.map(function (x) { x = x || {}; return '<tr><td data-label="Added">' + when(x.addedAt) + '</td><td data-label="Note">' + esc(x.note || '—') + '</td></tr>'; }).join('') +
        '</tbody></table>' : '<p class="adm-sub" style="margin-top:12px">No invitations on the list.</p>';
      return list;
    }, function () { return null; });
  }

  // ── registry ───────────────────────────────────────────────────────────────────────────────────────────────────────
  var entry = {
    key: 'admin', title: 'Admin dashboard', sub: 'Who has signed up, from where and how (owner only)', group: 'Overview', icon: '&#9881;',
    navHidden: true, render: render,
  };
  var registered = false;
  function register(o) {
    o = o || {};
    if (registered) return true;
    var a = A();
    var host = HAS_DOC ? document.getElementById('wts_account_host') : null;
    var hostReady = !!host && !host.getAttribute('data-acct-created');
    if (!o.force && !(a && a.betaEnabled && a.betaEnabled() && hostReady)) return false;
    G.WTS_calcRegistry = G.WTS_calcRegistry || {};
    G.WTS_calcRegistry.admin = entry;
    registered = true;
    return true;
  }
  function onRoute() { try { var P = G.WTS_pageAutosave; return !!(P && typeof P.page === 'function' && P.page() === 'admin'); } catch (e) { return false; } }
  function open() {
    if (registered && typeof G.WTS_nav === 'function') { G.WTS_nav('admin'); return true; }
    return null;
  }
  // the admin flag arrives with GET /me (after the page may already show "Not available"): redraw the open page when it changes
  var lastAdmin = null;
  function onState() {
    var now = isAdmin();
    if (now === lastAdmin) return;
    lastAdmin = now;
    if (registered && onRoute()) render($('pgBody'));
  }
  (function boot() {
    var a = A();
    if (a && typeof a.on === 'function') a.on('state', onState);
    // a load with #admin opens the page (it shows "Not available" until /me says admin:true)
    if (String(L.hash || '') === '#admin' && a && a.betaEnabled && a.betaEnabled() && HAS_DOC) {
      var go = function () { if (register()) open(); };
      if (document.readyState === 'loading' && document.addEventListener) document.addEventListener('DOMContentLoaded', go, { once: true });
      else if (typeof G.setTimeout === 'function') G.setTimeout(go, 0);
    }
  })();
  G.WTS_accountAdmin = { VERSION: VERSION, entry: entry, render: render, register: register, open: open, isAdmin: isAdmin,
    _csv: csv, _countryName: countryName, _flag: flag, _days90: days90, _view: function () { return view; }, _load: load };
  register();
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () {
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var P = G.WTS_accountAdmin;
  if (P && P.entry && P.entry.navHidden !== true) throw new Error('69 self-test: the admin page must be navHidden');
  if (P && P._flag('AE') !== '🇦🇪') throw new Error('69 self-test: flag');
})();
