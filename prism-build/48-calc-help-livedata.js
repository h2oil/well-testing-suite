// Help content: Live Data (docs/HELP-GUIDE-PLAN.md §4, WP-C5). Data only.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'livedata', routes: ['wellos', 'modbus', 'historian'], build: function () {
function V(m, k, t) { var v = { mark: m, text: t }; if (k) v.match = k; return v; }
function I(l, d, t) { var v = { label: l, text: t }; if (d) v.def = d; return v; }
function nd(why, ids) { return ids.split(' ').map(function (x) { return { id: 'hist_' + x, why: why }; }); }
var LIVE = 'Live values; read from the page for v3.3.2.';
return { guides: {

wellos: {
route: 'wellos', reviewed: 'v3.3.2', reviewedSrc: '9fe0919f', units: 'dual', notDocumented: [],
keywords: ['SCADA', 'control room', 'live view', 'alarm', 'acknowledge', 'CSV log', 'quality', 'stale'],
boldExempt: ['Use the Modbus simulator demo', 'Pause polling', 'Ack'],
purpose: 'A live control-room view of the spread: tiles, process view, trends, alarms, a CSV log and a pressure trend for PRiSM.',
what: ['**Form data** runs the simulator model from the [[wts]] inputs or the sample well. **Modbus data** shows the tags linked on the [[modbus]] page, each with a quality mark. The [[historian]] records every value.'],
when: ['Watch a live test from the gauges and the PLC, all alarms in one list.', 'Train a crew on the simulator model before any hardware is connected.', 'Send a gauge pressure trend to PRiSM.'],
steps: [
{ t: 'Select **Mini WellOS** in **Live Data**.', shot: 'view' },
'Choose the data source ①: **Form data** or **Modbus data**.',
{ t: 'In **Modbus data** with no tags linked, select **Use the Modbus simulator demo** in the banner (virtual slave).', shot: 'modbus' },
'In Form data, set the speed ②: **1×**, **10×** or **60×**. In Modbus data that place holds **Pause polling**.',
'Switch the process view with **3D** or **2D** ③; without 3D the page shows 2D.',
'Read the tiles and **Live variables**: each value shows its quality and source.',
'Under **Trends**, tick up to six variables; pick the window, **5 min** to **12 h**.',
'Under **Alarms**: **Ack** or **Acknowledge all**; **Events** keeps the history.',
'Under **CSV logging**: **Start logging**, then **Download CSV**.',
'Under **Send to PRiSM**, choose the **Pressure gauge** and select **Send trend window to PRiSM**.'],
inputs: [
I('Data source', 'Form data', 'The simulator model, or the linked Modbus tags.'),
I('Speed', '1×', 'Form data only.'),
I('Trends', 0, 'Up to six variables; window 5 min, 30 min, 2 h or 12 h.'),
I('Pressure gauge', 'Wellhead pressure (WHP)', 'The pressure sent to PRiSM.')],
outputs: [
I('Tiles', 0, 'Wellhead, bottom-hole gauge and separator pressure, the three rates, GOR (gas to oil ratio), water cut, flare gas rate.'),
I('Quality', 0, 'good = fresh; stale = no update for 3 poll intervals; bad = comms error, exception or unit mismatch; — = not linked.'),
I('Alarms', 0, 'HI, HIHI, LO, LOLO from the tag limits, or simulator alarms; UNACKNOWLEDGED, acknowledged or normal.')],
verdicts: [
V('✓', 'points (', 'The trend window is a PRiSM dataset now; select **Open PRiSM**.'),
V('✗', 'Need at least 3 samples', 'Wait, or pick a longer window.'),
V('✗', 'PRiSM is not available', 'Open PRiSM once, or reload the app.'),
V('✗', 'PRiSM rejected', 'Pick a window where the pressure changes.')],
example: { title: 'Form data, default simulator inputs', setup: ['**Form data**, speed 1×.'],
result: ['Wellhead {{3000|pressureG}}, separator about {{150|pressureG}}; gas {{10|gasRate|1}}, oil about {{1000|liquidRate}}, water cut 16.7 %.'],
check: { kind: 'manual', reason: LIVE } },
tips: ['In Modbus data the 3D and 2D views keep the last form values for what is not linked.'],
pitfalls: ['A value shown as — is not linked: use **Link to app variable** on [[modbus]].'],
refs: [{ std: 'ANSI/ISA-18.2', note: 'alarm states and acknowledgement' }],
related: ['modbus', 'historian', 'prism', 'wts'],
shots: [
{ id: 'view', view: 'both', alt: 'Mini WellOS in Form data: tiles and process view', caption: 'The page as it opens',
callouts: [{ sel: '#wos_head [data-src="modbus"]', n: 1 }, { sel: '#wos_head [data-speed="10"]', n: 2 }, { sel: '#wos_head [data-view="2d"]', n: 3 }] },
{ id: 'modbus', view: 'desktop', target: '#wos_kpis', alt: 'Tiles fed by the Modbus simulator demo', caption: 'Modbus data from the virtual slave', setup: [{ action: 'wellosDemo' }] }]
},

modbus: {
route: 'modbus', reviewed: 'v3.3.2', reviewedSrc: '8fa4158b', units: 'field', notDocumented: [],
notice: 'Each tag reads in its own units; a linked tag is converted to field units (psig, °F, MMSCFD, bbl/d). Metric mode does not change this page.',
keywords: ['PLC', 'RTU', 'register', 'tag', 'bridge', 'RS-485', 'gateway', 'polling', 'scaling', 'word order'],
boldExempt: ['Test read'],
purpose: 'Connects PLCs, RTUs and gauges over Modbus TCP or RTU, scales registers into tags and links them to app variables.',
what: ['Add the devices, then one tag per register. A linked tag feeds [[wellos]]; the [[historian]] records it. The page is read-only unless writes are enabled.'],
when: ['Before a test: map the gauge or PLC registers.', 'Training with no hardware: load the simulator.', 'A value reads wrong: check table, address, type and word order.'],
steps: [
{ t: 'Select **Modbus Config** in **Live Data**.', shot: 'view' },
'No hardware? Select **Load simulator demo** ①: 37 tags on the virtual slave.',
'Otherwise select **+ Add device**, one row per device ([[modbus#devices|Devices]]).',
'Select **+ Add tag** for each register and link it ([[modbus#tags|Tags]]).',
{ t: 'Select **Test** at the end of the device row ②; **Status** shows the result. **Test read** checks one tag.', shot: 'devs' },
'Select **Start live monitor** to poll; **Pause polling** stops it for every page.',
{ t: 'Read the **Configuration summary** ③: the issues are listed under it; a highlighted row has the reason as a tooltip.', shot: 'sum' },
'Open [[wellos]] and set its data source to **Modbus data**.'],
outputs: [
I('Configuration summary', 0, 'Devices, tags, linked variables, addressing, writes, polling.'),
I('Live value, Status', 0, 'Scaled value in the tag units, marked stale or bad; device idle, online or the last error.')],
verdicts: [
V('✓', 'Configuration is valid', 'Every device and tag passed the checks.'),
V('⚠', 'configuration issue', 'Fix the highlighted rows.'),
V('✓', 'Simulator demo loaded', 'The demo replaced the configuration.')],
example: { title: 'The simulator demo', setup: ['Select **Load simulator demo**.'],
result: ['1 device, 37 tags, 34 of 34 app variables linked.', 'The bottom-hole gauge tag is in barg; Mini WellOS shows about {{5400|pressureG}} in field units.'],
check: { kind: 'manual', reason: LIVE } },
tips: ['The **Built-in Modbus simulator (virtual slave)** card: its live values, and a register map to copy.'],
pitfalls: ['A switched-off device or one without tags is not polled.'],
refs: [{ std: 'Modbus Application Protocol Specification V1.1b3', note: 'tables, function codes, exceptions' }],
related: ['wellos', 'historian'],
parts: [
{ id: 'devices', title: 'Devices', inputs: [
I('Transport', 'Built-in simulator (virtual slave)', 'WebSocket bridge (web), Web Serial (RTU) or iOS native TCP.'),
I('Host / IP, Port', '502', 'The device (PLC) address.'),
I('Bridge URL / serial', 0, 'Use the bridge PC\'s IP, not its name; serial: baud, parity, stop bits.'),
I('Unit id', '1', 'The slave address; a gateway needs the RS-485 address.'),
I('Poll, Timeout', '1000 ms', 'Poll 100 ms to 60 s; stale after 3 missed polls.'),
I('Byte / word order', 'ABCD', 'CDAB word swap, BADC byte swap, DCBA little-endian.')] },
{ id: 'tags', title: 'Tags', inputs: [
I('Register addressing', '0-based', '1-based uses PLC numbers: 40001 is holding register 0.'),
I('Register table, Data type', 'Holding, FLOAT32', 'Coil, discrete input, input or holding register; 16, 32 or 64 bit.'),
I('Scaling', 'None', 'Raw → Eng: a line through two points. Gain / offset: value × gain + offset.'),
I('LOLO, LO, HI, HIHI', 0, 'Alarm limits for [[wellos]], with a deadband.'),
I('Link to app variable', '— not linked —', 'The app value the tag feeds; Log sends it to the [[historian]].')] },
{ id: 'writes', title: 'Writes', steps: [
'Tick **Enable writes (FC05 / 06 / 15 / 16)** and confirm.',
'Choose the **Tag to write** and a value.',
'Select **Write…** and confirm.'],
inputs: [{ label: 'Tag to write', id: 'mbc_wtag_sel', text: 'Coils and holding registers only.' }],
verdicts: [V('✗', 'Writes are disabled', 'Tick **Enable writes** first.'), V('✓', 'Wrote', 'The device took the value.'),
V('✗', 'Choose a writable tag', 'Pick a coil or holding tag; type a number.'),
V('✗', 'Modbus exception', 'Refused; exception 01: the bridge is read-only (Troubleshooting).')] },
{ id: 'io', title: 'Import / export', steps: [
'**Export JSON** saves the whole configuration; **Export tags CSV** the tag list.',
'**Import JSON…** replaces the configuration; **Import tags CSV…** adds tags. Then choose the file.',
'**Clear all** removes every device and tag.'],
verdicts: [V('✓', 'Imported', 'Issues are in the summary.'),
V('✗', 'Not valid JSON', 'Not a configuration file.'),
V('✗', 'CSV', 'The CSV needs name and address columns; export one to see the layout.')] },
{ id: 'setup', title: 'Real equipment',
what: ['Follow the **Connecting to real equipment — setup guide** card: install, check, troubleshooting.'],
steps: [
'Web: install the bridge on a PC on the device network, then select **Check bridge**.',
'iOS app: transport **Modbus TCP (iOS app, native)**; no bridge.',
'RS-485: **Modbus RTU via Web Serial** in a desktop browser; **Test** asks for the port.'],
verdicts: [
V('✓', 'Any device IP / port', 'It listens on this PC only.'),
V('✓', 'is running at', 'The bridge answered.'),
V('⚠', 'is running at', 'Read the warnings below it.'),
V('✗', 'NOT in the allow-list', 'Re-run the installer with that device or any device.'),
V('✗', 'No bridge answered', 'Install or start the bridge; check the URL.'),
V('✗', 'No answer from', 'As above.'),
V('✗', 'Something answered', 'Another program or an old bridge: re-install, or change the port.'),
V('✗', 'refused', 'Open the app from {{site}} or localhost; use the bridge PC\'s IP.'),
V('✗', '403 Forbidden', 'An old bridge: install the current one.')] }],
shots: [
{ id: 'view', view: 'both', alt: 'Modbus Configuration with no devices', caption: 'The page as it opens', callouts: [{ sel: '#mbc_root [data-act="demo"]', n: 1 }] },
{ id: 'devs', view: 'desktop', target: '#mbc_devs', alt: 'Virtual slave device row and status', caption: 'Devices after the demo',
setup: [{ action: 'modbusSimDemo' }], callouts: [{ sel: '#mbc_devs tr[data-row="dev"]', n: 2 }] },
{ id: 'sum', view: 'desktop', target: '#mbc_res .rbox', alt: 'Demo configuration summary', caption: 'Configuration summary',
setup: [{ action: 'modbusSimDemo' }], callouts: [{ sel: '#mbc_res .rbox-title', n: 3 }] }]
},

historian: {
route: 'historian', reviewed: 'v3.3.2', reviewedSrc: '27ab1ca9', units: 'field',
notice: 'Values keep the unit they were recorded in; Metric mode does not convert them.',
keywords: ['history', 'database', 'backup', 'restore', 'retention', 'rollup', 'xlsx'],
notDocumented: nd('button, in the steps', 'demo_btn demohist_btn refresh_btn modbus_btn modbus_btn2 custom_apply live_btn reset_btn png_btn prev_btn next_btn copy_btn sort_btn export_btn import_btn ret_btn engine_btn persist_btn purge_btn clear_btn'),
purpose: 'Records, trends, tabulates and exports tag data from Modbus, Mini WellOS and the Well Test form, on this device.',
what: ['It records the [[modbus]] tags, the [[wellos]] form values, and the Well Test form while **Log form data** is ticked. Times are UTC, shown in local time.'],
when: ['Review a test, tag by tag, over hours or days.', 'Export data for a report or PRiSM.', 'Back up before clearing a device or changing the engine.'],
steps: [
{ t: 'Select **Historian** in **Live Data**.', shot: 'view' },
'No data yet? Select **Start demo data** ① or **Add 24 h of demo history**. **Refresh** reloads the status.',
'Set up live tags on the [[modbus]] page (**Modbus configuration →**), or tick **Log form data**.',
'Under **Trend**, pick the range ② and tags. **Custom** needs From, To, **Apply range**.',
'**Live** follows the newest sample. Drag to pan, wheel or pinch to zoom; **Reset zoom**.',
'Set **Values** and **Layout**; **Export PNG**.',
'In the **Data table**, page with **‹ Prev** / **Next ›**, sort by the **Time** heading, or **Copy (tab-separated)**.',
{ t: 'Under **Export and restore**, choose format, range, tags and values, then **Export** ③.', shot: 'export' },
'To restore, choose the file and **Restore mode**, then **Restore**.',
'Under **Storage and retention**, set the limits and select **Apply retention**. A new **Storage engine** applies only after **Switch engine (moves the data)**.',
'Select **Request persistent storage**: else a browser may clear the data when short of space.'],
inputs: [
I('Values', 'Auto', 'Raw, or average, minimum, maximum or last per bucket.'),
I('Export format', 'CSV, one row per sample', 'Or a column per tag, .xlsx, or a .sqlite / .json backup.'),
I('Restore mode', 'Merge into the current data', 'Replace deletes all current data first.'),
I('Keep data for', '30 days', '0 = for ever.'),
I('Downsample raw data older than', '7 days', 'Into 1-minute rollups.'),
I('Storage engine', 'Automatic (best available)', 'Memory only is not saved.')],
outputs: [
I('Historian status', 0, 'Engine, samples, tags, samples waiting.'),
I('Tag logging status', 0, 'Per tag: unit, samples, last value, quality, logging.'),
I('Table marks', 0, '◌ stale, ✗ bad or none, † 1-minute mean.')],
verdicts: [
V('✓', 'Exported', 'The file is saved.'),
V('✗', 'No samples to export', 'Widen the range.'),
V('✗', 'No tags selected', 'Choose All tags or tick tags.'),
V('✓', 'Restored', 'Counts: new, overwritten, kept.'),
V('⚠', 'older than the retention', 'Raise Keep data for first.'),
V('✗', 'Choose a file', 'Choose the file.'),
V('✗', 'Not a ', 'Use a historian backup or export.'),
V('✗', 'column', 'A CSV needs a time column (time_utc) and value columns.'),
V('✓', 'Retention saved', 'Applies now and at every run.'),
V('✓', 'Now using', 'The data moved.'),
V('✗', 'Could not switch', 'The data stays; keep Automatic.'),
V('✓', 'storage granted', 'The data is kept.'),
V('✗', 'persistent storage', 'Export backups often.'),
V('✓', 'Deleted', 'Done.'),
V('✗', 'custom range', 'Set To after From.'),
V('✗', 0, 'Other ✗ lines (as under the trend): a store error. Reload; export a backup.')],
example: { title: 'Demo history', setup: ['On an empty historian, select **Add 24 h of demo history**.'],
result: ['Four DEMO tags, a sample every 10 s for 24 h; about 1 in 97 stale, 1 in 331 bad.'],
check: { kind: 'manual', reason: 'Asynchronous storage; the set follows from the page generator.' } },
tips: ['Bucket values use the good samples; averages are not time-weighted.'],
pitfalls: ['**Purge** and **Delete all historian data** cannot be undone: export a backup first.'],
refs: [{ std: 'Steinarsson (2013)', note: 'trend downsampling' }],
related: ['modbus', 'wellos', 'prism'],
shots: [
{ id: 'view', view: 'both', alt: 'Historian status, demo buttons, trend', caption: 'The page as it opens',
callouts: [{ sel: '#hist_demo_btn', n: 1 }, { sel: '#hist_root [data-seg="Time range"]', n: 2 }] },
{ id: 'export', view: 'desktop', target: '#hist_root > .card:nth-child(4)', alt: 'Export and restore card', caption: 'Export and restore', callouts: [{ sel: '#hist_export_btn', n: 3 }] }]
}

} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
