// Modbus page (route `modbus`) + Mini WellOS (route `wellos`) in the full app.
//
// End-to-end: config → poll (virtual slave over the simulator transport) → mapped
// variables → Mini WellOS values; the Form ↔ Modbus toggle; persistence and project files;
// write protection; historian hook; CSV logging; Send to PRiSM; timers stop when the page
// closes; iOS native-TCP transport contract (mock Capacitor plugin) and the Xcode wiring.
//
// Expected values: the virtual slave publishes known values (its driver.values, i.e. the
// WTS_sim state it was fed); the test checks they arrive through the encode → Modbus →
// decode → scale → unit-convert chain within the representation error of each register
// format (float32: 2^-23 relative; ×0.1 gain: 0.05; 0-10000 → 0-100 %: 0.005 %; 1/64 in: exact),
// and that BHP sent in barg comes back in psig (1 bar = 100/6.894757 psi, NIST SP 811).
'use strict';

const fs = require('fs');
const path = require('path');
const WP = 'MODBUS';
const REPO = path.resolve(__dirname, '..', '..');
const OPTS = { console: 'capture' };
const navBtn = (app, key) => app.find('.nav-btn[data-p="' + key + '"]');
const text = (el) => String(el ? el.textContent : '').trim();
const groupLabel = (btn) => { const g = btn && btn.closest('.nav-group'); const l = g && g.querySelector('.nav-group-label'); return l ? text(l) : null; };

async function demo(app) {
  app.click(navBtn(app, 'modbus'));
  app.click(app.find('[data-act="demo"]'));
  return app.win.WTS_modbus;
}

module.exports = [
  {
    name: 'registry: Modbus page in "Live Data", Mini WellOS in its own "Mini WellOS" group; titles, tiles, no WTS page change',
    wp: WP, opts: OPTS,
    run(app, assert) {
      const W = app.win;
      assert.fn(W.WTS_modbus.createClient); assert.fn(W.WTS_modbus.getTags);
      const m = navBtn(app, 'modbus'), w = navBtn(app, 'wellos');
      assert.ok(m && w, 'nav buttons');
      assert.strictEqual(groupLabel(m), 'Live Data'); assert.strictEqual(groupLabel(w), 'Mini WellOS');
      assert.notStrictEqual(m.closest('.nav-group'), navBtn(app, 'wts') ? navBtn(app, 'wts').closest('.nav-group') : null, 'separate from the Well Test Simulator');
      app.click(w);
      assert.strictEqual(text(app.el('pgTitle')), 'Mini WellOS');
      assert.ok(app.el('wos_root') && app.el('wos_kpis') && app.el('wos_lv') && app.el('wos_trend'));
      assert.ok(app.el('wos_root').hasAttribute('data-no-persist'), 'page state managed by the page, not the host autosave');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => text(c.querySelector('h3')));
      assert.ok(titles.includes('Modbus Configuration') && titles.includes('Mini WellOS'), 'dashboard tiles');
    },
  },
  {
    name: 'config page: simulator demo → saved config, getTags(), config-changed event, test read, device test',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const W = app.win, evs = [];
      app.document.addEventListener('wts:modbus-config-changed', (e) => evs.push(e.detail));
      const M = await demo(app);
      const cfg = JSON.parse(app.storage.getItem('wts_modbus_config'));
      assert.strictEqual(cfg.tags.length, 37); assert.strictEqual(cfg.devices[0].transport, 'sim'); assert.strictEqual(cfg.writesEnabled, false);
      assert.ok(evs.length >= 1 && evs[evs.length - 1].config.tags.length === 37, 'wts:modbus-config-changed fired');
      const tags = M.getTags();
      assert.strictEqual(tags.length, 37);
      const whp = tags.find((t) => t.name === 'WHP');
      assert.deepStrictEqual(Object.keys(whp).sort(), ['desc', 'device', 'engMax', 'engMin', 'linkedVar', 'name', 'unit']);
      assert.strictEqual(whp.device, 'Virtual slave'); assert.strictEqual(whp.linkedVar, 'whp'); assert.strictEqual(whp.unit, 'psig');
      const lvl = tags.find((t) => t.name === 'SURGE_LVL_A'); assert.strictEqual(lvl.engMin, 0); assert.strictEqual(lvl.engMax, 100);
      assert.strictEqual(app.findAll('#mbc_tagtable tbody tr').length, 37);
      assert.ok(/✓ Configuration is valid/.test(text(app.el('mbc_res'))));
      // Test read of SEP_P (FLOAT32 CDAB at input 40) and a device test
      const ctl = M.page.controller();
      app.click(app.find('[data-act="tag-read"][data-id="tag_demo_15"]'));
      await app.flushAsync(50);
      assert.ok(ctl.lastTestRead && !ctl.lastTestRead.error, 'test read ok');
      assert.near(ctl.lastTestRead.value, M.virtualSlave().driver.values.sep_p, Math.abs(M.virtualSlave().driver.values.sep_p) * 2e-7 + 1e-9);
      assert.match(text(app.find('[data-live="tag_demo_15"]')), /psig/);
      app.click(app.find('[data-act="dev-test"][data-id="dev_virtual"]'));
      await app.flushAsync(50);
      assert.ok(ctl.lastDevTest && ctl.lastDevTest.ok && ctl.lastDevTest.tags === 37, JSON.stringify(ctl.lastDevTest));
      app.flush(2000);   // host autosave / report-snapshot debounces after the clicks
      assert.strictEqual(app.pendingTimers(), 0, 'no timers after one-off reads');
    },
  },
  {
    name: 'end to end: config → poll → linked variables equal the virtual slave values (every data type / scaling / unit path)',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const M = await demo(app);
      const cfg = M.getConfig(); cfg.tags.forEach((t) => { t.deadband = 0; }); M.saveConfig(cfg);   // compare every sample exactly
      const st = M.acquire('test');
      await app.flushAsync(1200);
      const drv = M.virtualSlave().driver.values;
      const tol = { whp: 'f', choke_dn_p: 'f', heater_t: 'f', sep_t: 'f', gas_rate: 'f', oil_rate: 'f', water_rate: 'f', flare_rate: 'f', flare_p: 'f', surge_p: 'f',
        bht: 'f', lcv_oil: 'f', lcv_water: 'f', pcv_sep: 'f', sep_p: 'f', wht: 0.05, choke_bean: 0.5, sep_liq_lvl: 0.005, sep_int_lvl: 0.005, sep_oil_lvl: 0.005,
        surge_lvl_a: 0.005, surge_lvl_b: 0.005, gauge_lvl_a: 0.005, gauge_lvl_b: 0.005 };
      Object.keys(tol).forEach((k) => {
        const x = st.getVar(k);
        assert.ok(x && x.q === 'good', k + ' good');
        const t = tol[k] === 'f' ? Math.abs(drv[k]) * 1.2e-7 + 1e-9 : tol[k];
        assert.near(x.value, drv[k], t, k);
      });
      // BHP: canonical psig → barg on the wire (float32) → psig again
      assert.near(st.getVar('bhp').value, drv.bhp, Math.abs(drv.bhp) * 2e-7, 'bhp through barg');
      assert.near(M.toCanonical(10, 'barg', 'pressureG'), 145.0377377, 1e-6);
      ['esd_open', 'esd_tripped', 'pump_running', 'xv201a', 'xv201b', 'xv301a', 'xv301b', 'heater_bypass', 'p201_running'].forEach((k) => assert.strictEqual(st.getVar(k).value, drv[k] ? 1 : 0, k));
      // 7 block reads cover 37 tags (float block at input 0-29, levels 110-116, …)
      assert.strictEqual(st.blocks('dev_virtual').length, 7);
      M.release('test');
      assert.strictEqual(M.station(), null);
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0);
    },
  },
  {
    name: 'Mini WellOS toggle: Form data ↔ Modbus data, quality + comms status, 3D/2D state from live tags, historian hook',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const W = app.win, recs = [], evs = [];
      W.WTS_historian = { record: (b) => recs.push(b) };
      app.document.addEventListener('wts:modbus-samples', (e) => evs.push(e.detail));
      const M = await demo(app);
      app.click(navBtn(app, 'wellos'));
      const C = M.wellos.controller();
      assert.strictEqual(C.ui().source, 'form');
      await app.flushAsync(1100);
      // Form data: values from the private simulator model, historian batches with device 'form'
      assert.strictEqual(W.WTS_state.wellos.source, 'form');
      assert.near(W.WTS_state.wellos.values.whp, 3000, 30, 'sample well WHP ≈ 3000 psig');
      assert.strictEqual(W.WTS_state.wellos.quality.bhp, 'unmapped', 'BHP is not part of the form model');
      const formBatch = recs.find((b) => b[0] && b[0].device === 'form');
      assert.ok(formBatch && formBatch.some((s) => s.tag === 'whp' && s.q === 'good' && typeof s.v === 'number'), 'form samples pushed to the historian');
      assert.strictEqual(M.station(), null, 'no polling in Form mode');
      // switch to Modbus data
      app.click(app.find('[data-act="src"][data-src="modbus"]'));
      assert.strictEqual(C.ui().source, 'modbus');
      await app.flushAsync(2100);
      const st = M.station();
      assert.ok(st && st.isRunning(), 'station running while Mini WellOS shows Modbus data');
      const cur = C.current(), drv = M.virtualSlave().driver.values;
      assert.strictEqual(cur.q.whp, 'good'); assert.strictEqual(cur.q.bhp, 'good');
      assert.near(cur.vals.whp, st.getVar('whp').value, 1e-9);
      assert.near(cur.vals.surge_lvl_a, drv.surge_lvl_a, 0.51, 'within the 0.5 % demo deadband');
      assert.strictEqual(cur.src.whp, 'WHP');
      assert.match(text(app.el('wos_comms')), /Virtual slave · online · last \d\d:\d\d:\d\d/);
      assert.match(text(app.find('.wos-chip[data-var="sep_p"]')), /SEP_P/);
      // the display state is the frozen base with the live values applied
      const ds = C.displayState();
      assert.near(ds.nodes.wellhead.P, st.getVar('whp').value, 1e-9);
      assert.near(ds.gauge.tanks[0].frac * 100, st.getVar('gauge_lvl_a').value, 1e-9);
      // historian: one batch per poll with the documented sample shape
      const mb = recs.filter((b) => b[0] && b[0].device === 'Virtual slave');
      assert.ok(mb.length >= 2, 'batches: ' + mb.length);
      const s0 = mb[0].find((s) => s.tag === 'WHP');
      assert.deepStrictEqual(Object.keys(s0).sort(), ['device', 'q', 'raw', 't', 'tag', 'unit', 'v']);
      assert.strictEqual(s0.q, 'good'); assert.strictEqual(s0.unit, 'psig');
      assert.ok(evs.length >= recs.length, 'wts:modbus-samples fired with each batch');
      // KPI tiles for the report
      const kpis = app.findAll('#wos_kpis .kpi').map((k) => text(k.querySelector('.kpi-l')));
      assert.deepStrictEqual(kpis, ['Wellhead pressure', 'Bottom-hole gauge pressure', 'Separator pressure', 'Gas rate', 'Oil rate', 'Water rate', 'GOR', 'Water cut', 'Flare gas rate']);
      // GOR = gas × 10^6 / oil (hand formula) from the displayed values
      assert.near(C.current().vals.gor, C.current().vals.gas_rate * 1e6 / C.current().vals.oil_rate, 1e-6);
      // pause / resume from the Mini WellOS header
      app.click(app.find('#wos_head [data-act="pause"]'));
      assert.strictEqual(M.getConfig().paused, true); assert.ok(st.isPaused());
      const n0 = mb.length; await app.flushAsync(3000);
      assert.strictEqual(recs.filter((b) => b[0] && b[0].device === 'Virtual slave').length, n0, 'no polls while paused');
      app.click(app.find('#wos_head [data-act="pause"]'));
      await app.flushAsync(1100);
      assert.ok(recs.filter((b) => b[0] && b[0].device === 'Virtual slave').length > n0, 'polling resumed');
      // back to Form data releases the station
      app.click(app.find('[data-act="src"][data-src="form"]'));
      assert.strictEqual(M.station(), null);
    },
  },
  {
    name: 'stale / bad quality and COMMS alarm when the device stops answering; ISA-18.2 acknowledge from the page',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const M = await demo(app);
      // HIHI on WHP: manual virtual-slave values (WHP 3600 > HIHI 3500)
      const cfg = M.getConfig(); cfg.sim.source = 'manual'; cfg.sim.manual = { whp: 3600 }; M.saveConfig(cfg);
      app.click(navBtn(app, 'wellos'));
      const C = M.wellos.controller();
      app.click(app.find('[data-act="src"][data-src="modbus"]'));
      await app.flushAsync(1500);
      const A = C.alarms();
      const al = A.list().find((a) => a.tag === 'WHP');
      assert.ok(al && al.level === 'HIHI' && al.state === 'UNACK' && al.active, 'WHP HIHI unacknowledged');
      await app.flushAsync(300);
      assert.match(text(app.el('wos_alarms')), /WHP/);
      app.click(app.find('#wos_alarms [data-act="ack"]'));
      assert.strictEqual(A.get(al.id).state, 'ACK');
      // device goes silent: swap the virtual slave's unit id so requests go unanswered
      M.virtualSlave().unit = 9;
      await app.flushAsync(4000);
      const st = M.station();
      assert.strictEqual(st.getVar('whp').q, 'bad');
      assert.ok(A.list().some((a) => a.level === 'COMMS' && a.active), 'COMMS alarm');
      assert.strictEqual(C.current().q.whp, 'bad');
      assert.match(text(app.el('wos_comms')), /error/);
      app.click(app.find('[data-act="ackall"]'));
      assert.ok(A.list().every((a) => a.state === 'ACK'));
      M.virtualSlave().unit = 1;
      await app.flushAsync(5000);
      assert.strictEqual(st.getVar('whp').q, 'good', 'recovered after reconnect');
    },
  },
  {
    name: 'write protection on the Modbus page: disabled by default, enable asks, each write asks, cancel writes nothing',
    wp: WP, opts: Object.assign({}, OPTS, { confirm: true }),
    async run(app, assert) {
      const M = await demo(app), C = M.page.controller(), S = M.virtualSlave();
      const sel = app.el('mbc_wtag_sel');
      const sp = Array.from(sel.querySelectorAll('option')).find((o) => /SEP_P_SP/.test(text(o)));
      assert.ok(sp, 'writable holding tag listed'); assert.ok(!Array.from(sel.querySelectorAll('option')).some((o) => /^WHP /.test(text(o))), 'input registers are not writable');
      app.select('mbc_wtag_sel', sp.value);
      app.find('[data-role="wval"]').value = '155.5';
      let ok = await C.doWrite();
      assert.strictEqual(ok, false); assert.match(text(app.el('mbc_wmsg')), /disabled/);
      assert.strictEqual(S.getValue('holding', 0, 'float32', 'ABCD'), 0);
      // enable writes (confirm → true)
      const cb = app.find('[data-k="cfg"][data-f="writesEnabled"]');
      app.check(cb, true);
      assert.strictEqual(M.getConfig().writesEnabled, true);
      assert.ok(app.dialogs.some((d) => d.type === 'confirm' && /Enable Modbus writes/.test(d.message)));
      ok = await C.doWrite();
      assert.strictEqual(ok, true);
      assert.near(S.getValue('holding', 0, 'float32', 'ABCD'), 155.5, 1e-4);
      assert.ok(app.dialogs.some((d) => /Write 155.5 psig to SEP_P_SP/.test(d.message)), 'per-write confirmation');
      // ESD trip command coil drives the virtual slave's simulator
      const st = M.createStation(M.getConfig());
      await st.write('tag_demo_33', 1, { confirmed: true });
      assert.strictEqual(S.driver.lastCommand, 'trip'); assert.strictEqual(S.coil[0], 0, 'momentary command resets');
    },
  },
  {
    name: 'write cancelled at the confirmation dialog sends nothing',
    wp: WP, opts: Object.assign({}, OPTS, { confirm: false }),
    async run(app, assert) {
      const W = app.win, M = W.WTS_modbus;
      const cfg = M.demoConfig(); cfg.writesEnabled = true; M.saveConfig(cfg);
      app.click(navBtn(app, 'modbus'));
      const C = M.page.controller();
      const sp = Array.from(app.el('mbc_wtag_sel').querySelectorAll('option')).find((o) => /SEP_P_SP/.test(text(o)));
      app.select('mbc_wtag_sel', sp.value); app.find('[data-role="wval"]').value = '99';
      assert.strictEqual(await C.doWrite(), false);
      assert.match(text(app.el('mbc_wmsg')), /cancelled/);
      assert.strictEqual(M.virtualSlave().getValue('holding', 0, 'float32', 'ABCD'), 0);
    },
  },
  {
    name: 'persistence: config + Mini WellOS source survive a reload and travel in project files; JSON / CSV import',
    wp: WP, opts: OPTS,
    async run(app, assert, ctx) {
      const M = await demo(app);
      app.click(navBtn(app, 'wellos'));
      app.click(app.find('[data-act="src"][data-src="modbus"]'));
      const payload = app.win.WTS_project._buildPayload();
      const keys = payload.modules.storage.keys;
      assert.ok(keys.wts_modbus_config && JSON.parse(keys.wts_modbus_config).tags.length === 37, 'config in the project file');
      assert.strictEqual(JSON.parse(keys.wts_wellos_ui).source, 'modbus');
      app.hook.nav('home');
      // reload: same storage
      const app2 = app.reload();
      const M2 = app2.win.WTS_modbus;
      assert.strictEqual(M2.getConfig().tags.length, 37);
      app2.click(navBtn(app2, 'wellos'));
      assert.strictEqual(M2.wellos.controller().ui().source, 'modbus', 'source restored');
      assert.ok(M2.station() && M2.station().isRunning());
      app2.hook.nav('home');
      // project file into a fresh session
      const app3 = ctx.loadApp({ fromSources: ctx.mode !== 'html', console: 'capture' });
      assert.strictEqual(app3.win.WTS_modbus.getConfig().tags.length, 0);
      const res = app3.win.WTS_project.loadFromObject(app3.toWin(JSON.parse(JSON.stringify(payload))));
      assert.ok(!res.error, JSON.stringify(res));
      assert.strictEqual(app3.win.WTS_modbus.getConfig().tags.length, 37, 'restored from the project file');
      // JSON / CSV import through the page controller
      app3.click(navBtn(app3, 'modbus'));
      const C3 = app3.win.WTS_modbus.page.controller();
      let r = C3.importText(JSON.stringify({ devices: [{ id: 'p', name: 'PLC-1', transport: 'ws', host: '10.0.0.5' }], tags: [] }), 'json');
      assert.ok(r.ok); assert.strictEqual(app3.win.WTS_modbus.getConfig().devices[0].name, 'PLC-1');
      r = C3.importText('name,device,table,address,type,unit,link\r\nPT_101,PLC-1,holding,40001,float32,bar,whp\r\n', 'csv');
      assert.ok(r.ok && r.count === 1);
      const t = app3.win.WTS_modbus.getConfig().tags[0];
      assert.strictEqual(t.name, 'PT_101'); assert.strictEqual(t.unit, 'bar'); assert.strictEqual(t.link, 'whp');
      assert.ok(C3.importText('{nope', 'json').ok === false);
      // 0/1-based toggle keeps the protocol address
      app3.change(app3.find('[data-k="cfg"][data-f="base"]'), '1');
      const t1 = app3.win.WTS_modbus.getConfig().tags[0];
      assert.strictEqual(t1.address, 440002, 'protocol 40001 shown 1-based in 6-digit PLC form');
      assert.strictEqual(app3.win.WTS_modbus.protocolAddress(t1.address, 'holding', 1), 40001);
      app3.change(app3.find('[data-k="cfg"][data-f="base"]'), '0');
      assert.strictEqual(app3.win.WTS_modbus.getConfig().tags[0].address, 40001, 'and back');
    },
  },
  {
    name: 'CSV logging download, Send to PRiSM commits a gauge dataset, timers stop when the page closes',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const W = app.win, M = W.WTS_modbus;
      app.click(navBtn(app, 'wellos'));
      const C = M.wellos.controller();
      app.click(app.find('[data-act="logstart"]'));
      await app.flushAsync(5200);
      app.click(app.find('[data-act="logstop"]'));
      assert.ok(C.logger.rows.length >= 5, 'rows: ' + C.logger.rows.length);
      app.click(app.find('[data-act="logcsv"]'));
      const dl = app.downloads[app.downloads.length - 1];
      assert.ok(dl && /^wellos-log-.*\.csv$/.test(dl.filename), 'download');
      const lines = String(dl.content).trim().split(/\r?\n/);
      assert.match(lines[0], /^timestamp_utc,epoch_ms,whp \[psig\],whp quality,wht \[°F\]/);
      assert.strictEqual(lines.length, C.logger.rows.length + 1);
      // Send to PRiSM: the WHP trend of the window becomes the active PRiSM dataset (t in hours)
      const s = C.series('whp', W.Date.now() - C.ui().win * 1000);   // app clock (virtual)
      const ds = C.sendToPrism();
      assert.ok(ds && W.PRiSM_dataset === ds || (W.PRiSM_dataset && W.PRiSM_dataset.name === ds.name), 'committed');
      assert.strictEqual(W.PRiSM_dataset.p.length, s.v.length);
      assert.near(W.PRiSM_dataset.t[W.PRiSM_dataset.t.length - 1], (s.t[s.t.length - 1] - s.t[0]) / 3.6e6, 1e-12, 'hours from the first sample');
      assert.near(W.PRiSM_dataset.p[0], s.v[0], 1e-12);
      assert.strictEqual(W.PRiSM_dataset.source, 'modbus');
      assert.match(text(app.el('wos_prism_msg')), /Sent \d+ points/);
      // historian placeholder (no historian route in this build)
      assert.ok(app.find('[data-historian-placeholder]') || navBtn(app, 'historian'), 'historian placeholder or link');
      // leaving the page stops the animation loop and releases the station
      assert.ok(C.isRunning());
      app.hook.nav('home');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, JSON.stringify(app.timers && app.timers().slice(0, 2)));
      assert.strictEqual(M.owners().length, 0, 'no station owners');
    },
  },
  {
    name: 'iOS native TCP transport contract (mock Capacitor plugin) and the Xcode / Info.plist wiring',
    wp: WP, opts: OPTS,
    async run(app, assert) {
      const W = app.win, M = W.WTS_modbus;
      // mock plugin following ModbusTcpPlugin.swift: connect → {id}; send(base64) → 'data' events
      const slave = M.createSlave({ unit: 1, sizes: { holding: 50 } }); slave.holding[7] = 4242;
      const L = {};
      const plugin = {
        connect: (o) => Promise.resolve({ id: 'c1', o }),
        send: (o) => { const res = slave.handleFrame(M.b64decode(o.data), 'tcp'); Promise.resolve().then(() => (L.data || []).forEach((f) => f({ id: o.id, data: M.b64encode(res) }))); return Promise.resolve(); },
        disconnect: () => Promise.resolve(),
        addListener: (e, f) => { (L[e] = L[e] || []).push(f); return Promise.resolve({ remove() {} }); },
      };
      const tr = M.transports.nativeTcp({ host: '10.0.0.5', port: 502, plugin });
      await tr.open();
      const c = M.createClient(tr, { timeout: 500 });
      const p = c.readHoldingRegisters(1, 7, 1);
      await app.flushAsync(10);
      assert.strictEqual((await p)[0], 4242);
      await c.close();
      assert.strictEqual(M.nativeTcpAvailable(), false, 'web build: native TCP not available');
      // Swift / Xcode wiring
      const swift = fs.readFileSync(path.join(REPO, 'ios-app/ios/App/App/ModbusTcpPlugin.swift'), 'utf8');
      assert.match(swift, /jsName = "ModbusTcp"/);
      ['connect', 'send', 'disconnect'].forEach((m) => assert.match(swift, new RegExp('CAPPluginMethod\\(name: "' + m + '"')));
      assert.match(swift, /notifyListeners\("data"/); assert.match(swift, /notifyListeners\("closed"/);
      assert.match(swift, /import Network/);
      const vc = fs.readFileSync(path.join(REPO, 'ios-app/ios/App/App/MainViewController.swift'), 'utf8');
      assert.match(vc, /registerPluginInstance\(ModbusTcpPlugin\(\)\)/);
      const pbx = fs.readFileSync(path.join(REPO, 'ios-app/ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
      assert.match(pbx, /ModbusTcpPlugin\.swift in Sources \*\/,/); assert.match(pbx, /MainViewController\.swift in Sources \*\/,/);
      const sb = fs.readFileSync(path.join(REPO, 'ios-app/ios/App/App/Base.lproj/Main.storyboard'), 'utf8');
      assert.match(sb, /customClass="MainViewController" customModule="App"/);
      const plist = fs.readFileSync(path.join(REPO, 'ios-app/ios/App/App/Info.plist'), 'utf8');
      assert.match(plist, /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
      const spm = fs.readFileSync(path.join(REPO, 'ios-app/ios/App/CapApp-SPM/Package.swift'), 'utf8');
      assert.ok(!/Modbus/i.test(spm), 'no SPM change (Package.resolved unaffected)');
    },
  },
];
