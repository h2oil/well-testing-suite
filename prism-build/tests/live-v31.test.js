// Live data v3.1 review — Modbus (60-62, 65), Mini WellOS (63), historian (47).
//   • A register that decodes to NaN / ±Inf (IEEE-754 sensor-fault patterns) or cannot be scaled is BAD quality with a
//     BAD alarm and a null historian sample — never a "good" non-number; the next valid value clears it.
//   • LCV-201 / P-201 naming: the legacy variable key pump_running (kept for saved mappings) is the LCV-201 transfer
//     valve; the gauge tank pump P-201 has its own variable p201_running; the demo map names them LCV201_OPEN and
//     P201_RUNNING (appended, so the earlier demo tag ids are unchanged).
//   • Mini WellOS form values reach the historian with a description (pump_running = "Transfer valve LCV-201 open …").
//   • Button sweeps on the Modbus page, Mini WellOS and the historian: every button works with no handler error,
//     clear messages where nothing can be done (device test with no tags / switched off), destructive actions ask.
// Expected values are protocol / IEEE-754 facts, P&ID tag names and configuration values — never numbers taken from
// the code under test.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WP = 'LIVE31';
const D = path.resolve(__dirname, '..');
const OPTS = { console: 'capture' };
const plain = (x) => JSON.parse(JSON.stringify(x));
const navBtn = (app, key) => app.find('.nav-btn[data-p="' + key + '"]');
const text = (el) => String(el ? el.textContent : '').trim();
const tick = () => new Promise((r) => setImmediate(r));
async function settle(app, n) { for (let i = 0; i < (n || 200); i++) { await tick(); if (app.pendingTimers()) app.flush(50); } }

function load(extra) {
  const ctx = Object.assign({ console: { log() {}, warn() {}, error() {} }, Math, Date, JSON, setTimeout, clearTimeout, Promise,
    Uint8Array, Uint16Array, Float64Array, DataView, ArrayBuffer, Buffer }, extra || {});
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ['60-modbus-core.js', '61-modbus-station.js']) vm.runInContext(fs.readFileSync(path.join(D, f), 'utf8'), ctx, { filename: f });
  return ctx.WTS_modbus;
}

module.exports = [
  {
    name: 'LIVE31 bad register values: NaN / ±Inf float32 (both word orders) and an unscalable tag → BAD quality + BAD alarm + null historian sample; a valid value clears it',
    wp: WP, opts: false,
    async run(app, assert) {
      let t = 5e6;
      const recs = [];
      const M = load({ WTS_historian: { record: (b) => recs.push(b) } });
      const S = M.createSlave({ unit: 1, sizes: { holding: 100 } });
      const cfg = { devices: [{ id: 'd1', name: 'PLC', transport: 'sim', pollMs: 1000, timeoutMs: 50, retries: 0 }],
        tags: [{ id: 'a', name: 'PT1', device: 'd1', table: 'holding', address: 0, type: 'float32', order: 'ABCD', unit: 'psig', link: 'whp', alarm: { hi: 3300 } },
               { id: 'b', name: 'PT2', device: 'd1', table: 'holding', address: 2, type: 'float32', order: 'CDAB', unit: 'psig', link: 'sep_p' },
               { id: 'c', name: 'LVL', device: 'd1', table: 'holding', address: 4, type: 'int16', scale: { mode: 'linear', rawMin: 10, rawMax: 10, engMin: 0, engMax: 100 }, unit: '%' }] };
      const st = M.createStation(cfg, { now: () => t, transportFor: () => M.transports.sim({ slave: S }) });
      // IEEE-754 single: 0x7FC00000 = quiet NaN, 0x7F800000 = +Inf (word swap CDAB: low word first)
      S.holding[0] = 0x7FC0; S.holding[1] = 0x0000;
      S.holding[2] = 0x0000; S.holding[3] = 0x7F80;
      S.holding[4] = 50;
      await st.pollNow();
      const a = st.value('a'), b = st.value('b'), c = st.value('c');
      assert.strictEqual(a.q, 'bad'); assert.match(a.err, /invalid value \(NaN\)/);
      assert.strictEqual(b.q, 'bad'); assert.match(b.err, /\+Inf/);
      assert.strictEqual(c.q, 'bad'); assert.match(c.err, /cannot be scaled/);
      assert.strictEqual(st.getVar('whp').q, 'bad'); assert.strictEqual(st.getVar('whp').value, null, 'no non-number reaches the app variable');
      assert.ok(!('whp' in plain(st.linkedValues())), 'not applied to the 3D / 2D state');
      const bad = st.alarms.list().filter((x) => x.level === 'BAD' && x.active).map((x) => x.tag).sort();
      assert.deepStrictEqual(plain(bad), ['LVL', 'PT1', 'PT2'], 'BAD alarms');
      const last = recs[recs.length - 1];
      assert.ok(last.every((s) => s.v === null && s.q === 'bad'), 'historian gets null / bad: ' + JSON.stringify(last));
      // valid values again → good, BAD alarm returns to normal (ISA-18.2: unacknowledged until acked)
      S.setValue('holding', 0, 'float32', 'ABCD', 3000); S.setValue('holding', 2, 'float32', 'CDAB', 150); t += 1000;
      await st.pollNow();
      assert.strictEqual(st.value('a').q, 'good'); assert.strictEqual(st.getVar('whp').value, 3000);
      assert.near(st.getVar('sep_p').value, 150, 1e-4);
      const A = st.alarms.get('a');
      assert.ok(A && !A.active && A.state === 'RTN', 'BAD alarm returned to normal: ' + JSON.stringify(A && plain(A)));
      // a later HI still works after a BAD (limits evaluated again)
      S.setValue('holding', 0, 'float32', 'ABCD', 3400); t += 1000; await st.pollNow();
      assert.strictEqual(st.alarms.get('a').level, 'HI');
      st.dispose();
    }
  },
  {
    name: 'LIVE31 WebSocket bridge that never confirms the device connection: open() gives up after openTimeoutMs with a clear message; close() while connecting leaves no timer',
    wp: WP, opts: false,
    async run(app, assert) {
      const timers = new Map(); let seq = 0;
      const setT = (f, ms) => { const id = ++seq; timers.set(id, { f, ms }); return id; }, clrT = (id) => { timers.delete(id); };
      const M = load();
      const sockets = [];
      function FakeWS(url) { this.url = url; this.closed = null; sockets.push(this); }
      FakeWS.prototype.close = function (code, why) { this.closed = why || code; };
      const tr = M.transports.webSocket({ url: 'ws://127.0.0.1:8502', host: '10.0.0.7', port: 502, WebSocket: FakeWS, openTimeoutMs: 4000, setTimeout: setT, clearTimeout: clrT });
      const p = tr.open();
      assert.strictEqual(timers.size, 1, 'one open timer while waiting for {"type":"open"}');
      const t = [...timers.values()][0]; assert.strictEqual(t.ms, 4000);
      t.f();
      await assert.rejects(p, /No answer through the bridge from 10\.0\.0\.7:502 within 4 s/);
      assert.strictEqual(sockets[0].closed, 'open timeout', 'socket closed');
      // confirmed → the timer is cleared at once
      const tr2 = M.transports.webSocket({ host: 'h', port: 502, WebSocket: FakeWS, setTimeout: setT, clearTimeout: clrT });
      timers.clear();
      const p2 = tr2.open(); sockets[1].onmessage({ data: '{"type":"open"}' });
      await p2; assert.strictEqual(timers.size, 0, 'cleared on open'); assert.strictEqual(tr2.isOpen(), true);
      // closed while connecting → no timer left
      const tr3 = M.transports.webSocket({ host: 'h', port: 502, WebSocket: FakeWS, setTimeout: setT, clearTimeout: clrT });
      tr3.open().catch(() => {}); assert.strictEqual(timers.size, 1); tr3.close(); assert.strictEqual(timers.size, 0, 'cleared on close');
    }
  },
  {
    name: 'LIVE31 LCV-201 / P-201 variables: pump_running = LCV-201 open (legacy key), p201_running = gauge tank pump; demo map names and stable ids',
    wp: WP, opts: false,
    run(app, assert) {
      const M = load();
      assert.match(M.VAR_BY_KEY.pump_running.label, /^Transfer valve LCV-201 open/);
      assert.match(M.VAR_BY_KEY.p201_running.label, /P-201/);
      assert.strictEqual(M.VAR_BY_KEY.p201_running.group, 'Gauge tank');
      const names = M.DEMO_MAP.map((m) => m[0]);
      assert.ok(names.indexOf('P201_RUN') < 0, 'no demo tag named after P-201 for the LCV-201 state');
      const lcv = M.DEMO_MAP.find((m) => m[0] === 'LCV201_OPEN'), p = M.DEMO_MAP.find((m) => m[0] === 'P201_RUNNING');
      assert.ok(lcv && lcv[1] === 'pump_running' && lcv[2] === 'discrete' && lcv[3] === 2, 'LCV201_OPEN keeps discrete input 2');
      assert.ok(p && p[1] === 'p201_running' && p[2] === 'discrete', 'P201_RUNNING');
      const demo = M.demoConfig();
      assert.strictEqual(demo.tags.find((x) => x.name === 'ESD_TRIP_CMD').id, 'tag_demo_33', 'earlier demo ids unchanged');
      // snapshot mapping: surge.transfer (legacy surge.pump) vs gauge.pump
      const st = { surge: { pump: { on: true } }, gauge: { pump: { on: false, mode: 'pump' } } };
      const v = M.varsFromState(st);
      assert.strictEqual(v.pump_running, 1); assert.strictEqual(v.p201_running, 0);
      st.gauge.pump.mode = 'none';
      assert.strictEqual(M.varsFromState(st).p201_running, null, 'no gauge tank in the rig-up → no P-201 value');
      // a saved v3.0 mapping (tag P201_RUN linked to pump_running) still normalises and links
      const n = M.normalizeConfig({ devices: [{ id: 'd', name: 'V', transport: 'sim' }], tags: [{ id: 't', name: 'P201_RUN', device: 'd', table: 'discrete', address: 2, link: 'pump_running' }] });
      assert.deepStrictEqual(plain(n.errors), []); assert.strictEqual(n.config.tags[0].link, 'pump_running');
    }
  },
  {
    name: 'LIVE31 Modbus page button sweep: devices, tags, poll rate, test read / device test (clear messages), demo, export / import, monitor, pause, poll now, guide buttons, clear',
    wp: WP, opts: Object.assign({}, OPTS, { confirm: true }),
    async run(app, assert) {
      const W = app.win, M = W.WTS_modbus;
      app.click(navBtn(app, 'modbus'));
      const C = M.page.controller();
      const act = (a, id) => app.find('[data-act="' + a + '"]' + (id ? '[data-id="' + id + '"]' : ''));
      // add a device, change its poll rate (min / max clamp), test it with no tags
      app.click(act('dev-add'));
      let cfg = M.getConfig(); assert.strictEqual(cfg.devices.length, 1);
      const dev = cfg.devices[0].id;
      const poll = app.find('[data-k="dev"][data-id="' + dev + '"][data-f="pollMs"]');
      app.change(poll, '250'); assert.strictEqual(M.getConfig().devices[0].pollMs, 250, 'poll rate saved');
      app.change(app.find('[data-k="dev"][data-id="' + dev + '"][data-f="pollMs"]'), '5'); assert.strictEqual(M.getConfig().devices[0].pollMs, M.POLL_MIN, 'clamped to the minimum');
      app.click(act('dev-test', dev)); await settle(app);
      assert.match(text(app.find('[data-devstat="' + dev + '"]')), /no tags on this device yet/);
      // add a tag, test read (virtual slave), switch the device off → the test says so
      app.click(act('tag-add'));
      cfg = M.getConfig(); assert.strictEqual(cfg.tags.length, 1);
      const tag = cfg.tags[0].id;
      app.click(act('tag-read', tag)); await settle(app);
      assert.ok(C.lastTestRead && !C.lastTestRead.error, 'test read: ' + JSON.stringify(C.lastTestRead));
      app.click(act('dev-test', dev)); await settle(app);
      assert.ok(C.lastDevTest && C.lastDevTest.ok, 'device test ok: ' + JSON.stringify(C.lastDevTest));
      app.check(app.find('[data-k="dev"][data-id="' + dev + '"][data-f="enabled"]'), false);
      app.click(act('dev-test', dev)); await settle(app);
      assert.match(text(app.find('[data-devstat="' + dev + '"]')), /switched off/);
      app.click(act('tag-del', tag)); assert.strictEqual(M.getConfig().tags.length, 0, 'tag deleted');
      app.click(act('dev-del', dev)); assert.strictEqual(M.getConfig().devices.length, 0, 'device deleted');
      // demo, monitor, pause / resume, poll now
      app.click(act('demo')); await settle(app);
      assert.strictEqual(M.getConfig().tags.length, M.DEMO_MAP.length);
      app.click(act('monitor')); await settle(app);
      assert.ok(M.station() && M.station().isRunning(), 'live monitor starts the station');
      app.click(act('pollnow')); await settle(app);
      app.click(act('pause')); assert.strictEqual(M.getConfig().paused, true);
      app.click(act('pause')); assert.strictEqual(M.getConfig().paused, false);
      const live = app.find('[data-live="tag_demo_0"]');
      assert.ok(live && !/^—$/.test(text(live)), 'live value shown: ' + text(live));
      app.click(act('monitor')); await settle(app);
      assert.strictEqual(M.station(), null, 'monitor stop releases the station');
      // export / import
      const d0 = app.downloads.length;
      app.click(act('exp-json')); app.click(act('exp-csv'));
      assert.strictEqual(app.downloads.length, d0 + 2, 'two downloads');
      const csv = M.tagsToCsv(M.getConfig());
      const r = C.importText(csv.split('\r\n').slice(0, 2).join('\r\n').replace('WHP', 'WHP_2'), 'csv');
      assert.ok(r.ok && r.count === 1, 'CSV import: ' + JSON.stringify(r));
      // addressing base toggle keeps protocol addresses
      app.select(app.find('[data-k="cfg"][data-f="base"]'), '1');
      assert.strictEqual(M.getConfig().base, 1);
      app.select(app.find('[data-k="cfg"][data-f="base"]'), '0');
      assert.strictEqual(M.getConfig().tags[0].address, 0, 'WHP back at protocol address 0');
      // guide buttons: OS, copy, package, installer (needs a bridge device), check bridge (no bridge → message)
      ['windows', 'macos', 'linux'].forEach((os) => { app.click(app.find('[data-act="guide-os"][data-os="' + os + '"]')); assert.strictEqual(C.guide.os, os); });
      const cp = app.find('[data-act="guide-copy"]'); assert.ok(cp, 'copy button'); app.click(cp); await settle(app);
      assert.ok(String(app.clipboard || '').length > 10, 'copied to the clipboard');
      const d1 = app.downloads.length;
      app.click(app.find('[data-act="guide-pack"]'));
      assert.strictEqual(app.downloads.length, d1 + 1, 'bridge package downloaded');
      app.click(app.find('[data-act="guide-check"]')); await settle(app, 400);
      assert.ok(C.lastCheck, 'bridge check ran');
      assert.match(text(app.el('mbc_guide_check')), /✗|✓|⚠/);
      // clear all (confirm)
      app.click(act('clear'));
      assert.strictEqual(M.getConfig().tags.length, 0);
      assert.deepStrictEqual(app.errors.map((e) => e.message), [], 'no handler errors');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
    }
  },
  {
    name: 'LIVE31 Mini WellOS button sweep: source, view, speed, windows, trends, logging + CSV, alarms ack, Send to PRiSM; the demo button asks before replacing tags; P-201 drawn',
    wp: WP, opts: Object.assign({}, OPTS, { confirm: false }),
    async run(app, assert) {
      const W = app.win, M = W.WTS_modbus;
      // an existing (unlinked) configuration must survive a cancelled "Use the Modbus simulator demo"
      M.saveConfig(W.JSON.parse(JSON.stringify({ devices: [{ id: 'p', name: 'PLC-9', transport: 'ws', host: '10.1.1.9' }], tags: [{ id: 'x', name: 'SPARE', device: 'p', table: 'holding', address: 7 }] })));
      app.click(navBtn(app, 'wellos')); app.flush(1200);
      const C = M.wellos.controller();
      const act = (a, extra) => app.find('[data-act="' + a + '"]' + (extra || ''));
      app.click(act('src', '[data-src="modbus"]')); app.flush(300);
      assert.strictEqual(C.ui().source, 'modbus');
      const demoBtn = act('demo'); assert.ok(demoBtn, 'demo button in the banner (no linked tags)');
      app.click(demoBtn);
      assert.ok(app.dialogs.some((d) => d.type === 'confirm' && /Replace the current Modbus configuration \(1 device\(s\), 1 tag\(s\)\)/.test(d.message)), 'asks');
      assert.strictEqual(M.getConfig().tags[0].name, 'SPARE', 'cancel keeps the configuration');
      app.click(act('src', '[data-src="form"]')); app.flush(300);
      assert.strictEqual(C.ui().source, 'form');
      ['2d', '3d', '2d'].forEach((v) => { app.click(act('view', '[data-view="' + v + '"]')); assert.strictEqual(C.ui().view, v); });
      [10, 60, 1].forEach((x) => { app.click(act('speed', '[data-speed="' + x + '"]')); assert.strictEqual(C.ui().speed, x); });
      [300, 7200, 1800].forEach((x) => { app.click(act('win', '[data-win="' + x + '"]')); assert.strictEqual(C.ui().win, x); });
      const tr = app.find('[data-trend="surge_p"]'); app.check(tr, true); assert.ok(C.ui().trend.indexOf('surge_p') >= 0);
      app.check(tr, false); assert.ok(C.ui().trend.indexOf('surge_p') < 0);
      app.click(act('logstart')); app.flush(3100);
      assert.ok(C.logger.rows.length >= 3, 'logging rows: ' + C.logger.rows.length);
      app.click(act('logstop'));
      const d0 = app.downloads.length; app.click(act('logcsv')); assert.strictEqual(app.downloads.length, d0 + 1, 'CSV download');
      app.click(act('logclear')); assert.strictEqual(C.logger.rows.length, 0);
      app.flush(2000);
      app.click(act('ackall')); const a = act('ack'); if (a) app.click(a);
      app.flush(60000);
      app.click(act('prism')); app.flush(100);
      assert.match(text(app.el('wos_prism_msg')), /✓ Sent|✗/);
      // P-201 glyph and label on the levels panel; LCV-201 labelled as the transfer valve
      const texts = app.canvasTexts('wos_lv').join(' | ');
      assert.ok(/P-201/.test(texts) && /LCV-201/.test(texts), 'levels panel: ' + texts.slice(0, 300));
      // form values reach the historian with their description
      const H = W.WTS_historian; await H.flush(); await settle(app);
      const tags = await H.listTags(), pr = tags.find((x) => x.tag === 'pump_running'), p2 = tags.find((x) => x.tag === 'p201_running');
      assert.ok(pr && /Transfer valve LCV-201 open/.test(pr.desc) && pr.source === 'form', 'historian pump_running: ' + JSON.stringify(pr));
      assert.ok(p2 && /P-201/.test(p2.desc), 'historian p201_running: ' + JSON.stringify(p2));
      assert.deepStrictEqual(app.errors.map((e) => e.message), [], 'no handler errors');
      navBtn(app, 'home') ? app.click(navBtn(app, 'home')) : app.hook.nav('home');
      await settle(app);
      app.flush(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers after leaving the page');
    }
  },
  {
    name: 'LIVE31 historian button sweep: every hist_* button can be pressed (demo, refresh, live, zoom, PNG, table, copy, export, retention, purge) with no handler error',
    wp: WP, opts: Object.assign({}, OPTS, { confirm: true }),
    async run(app, assert) {
      const W = app.win;
      app.click(navBtn(app, 'historian')); await settle(app);
      const H = W.WTS_historian;
      await H.demo.history(2, 60000); await settle(app);
      const ids = Array.from(app.document.querySelectorAll('button[id^="hist_"]')).map((b) => b.id);
      assert.ok(ids.length >= 12, 'buttons: ' + ids.join());
      const skip = new Set(['hist_import_btn', 'hist_engine_btn', 'hist_modbus_btn', 'hist_modbus_btn2']);   // file picker / engine switch: covered by historian.test.js; Modbus links leave the page (last)
      const pressed = [];
      for (const id of ids) {
        if (skip.has(id)) continue;
        const b = app.el(id); if (!b || b.disabled) continue;
        app.click(b); pressed.push(id); await settle(app, 60);
        if (id === 'hist_demo_btn' && H.demo.running()) { app.click(app.el(id)); await settle(app, 20); }
      }
      assert.ok(pressed.length >= 10, 'pressed: ' + pressed.join());
      const mb = app.el('hist_modbus_btn') || app.el('hist_modbus_btn2');
      if (mb) { app.click(mb); await settle(app, 20); assert.strictEqual(text(app.el('pgTitle')), 'Modbus Configuration', 'Modbus link'); }
      assert.ok(!H.demo.running(), 'demo stopped');
      assert.deepStrictEqual(app.errors.map((e) => e.message), [], 'no handler errors');
      await settle(app); app.flush(30000); await settle(app);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
    }
  }
];
