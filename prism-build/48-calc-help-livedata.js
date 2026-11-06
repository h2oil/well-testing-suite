// prism-build/48-calc-help-livedata.js — Help content: Live Data (docs/HELP-GUIDE-PLAN.md §4, WP-C5).
// Data only: wellos, modbus (parts), historian. The factory runs on the first Help open; nothing runs at load.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'livedata', routes: ['wellos', 'modbus', 'historian'], build: function () {
var LIVE = 'Live page: the values move with the simulator model or the polled tags; read from the page in the harness for v3.3.2.';
return { guides: {

wellos: {
route: 'wellos', reviewed: 'v3.3.2', reviewedSrc: '9fe0919f', units: 'dual', notDocumented: [],
keywords: ['SCADA', 'control room', 'live view', 'alarm', 'acknowledge', 'CSV log', 'quality', 'stale'],
boldExempt: ['Use the Modbus simulator demo', 'Pause polling', 'Ack'],
purpose: 'A live, control-room view of the well-test spread: tiles, process view, trends, alarms, a CSV log and a pressure trend for PRiSM.',
what: ['**Form data** runs the Well Test Simulator model from the [[wts]] inputs, or the sample well. **Modbus data** shows the tags linked on the [[modbus]] page, each with a quality mark. The [[historian]] records every value.'],
when: ['Watch a live test from the gauges and the PLC, with all alarms in one list.', 'Train a crew on the spread with the simulator model, before any hardware is connected.', 'Send a gauge pressure trend to PRiSM for a first build-up look.'],
steps: [
{ t: 'Select **Mini WellOS** in **Live Data**.', shot: 'view' },
{ t: 'Choose the data source ①: **Form data** or **Modbus data**.' },
{ t: 'No tags linked yet? Select **Use the Modbus simulator demo** in the banner to try the built-in virtual slave.', shot: 'modbus' },
{ t: 'In Form data, set the speed ②: **1×**, **10×** or **60×**. In Modbus data that place holds **Pause polling**.' },
{ t: 'Switch the process view with **3D** or **2D** ③. Where 3D cannot run, the page shows the 2D schematic.' },
{ t: 'Read the tiles and **Live variables**: each value shows its quality and its source.' },
{ t: 'Under **Trends**, tick up to six variables and pick the window, **5 min** to **12 h**.' },
{ t: 'Under **Alarms**, select **Ack** or **Acknowledge all**. **Events** keeps the history.' },
{ t: 'Under **CSV logging**, select **Start logging**, then **Download CSV**.' },
{ t: 'Under **Send to PRiSM**, choose the **Pressure gauge** and select **Send trend window to PRiSM**.' }],
inputs: [
{ label: 'Data source', def: 'Form data', text: 'Form data: the simulator model. Modbus data: the tags linked to app variables.' },
{ label: 'Speed', def: '1×', text: 'Form data only.' },
{ label: 'Trends', text: 'Up to six variables; window 5 min, 30 min, 2 h or 12 h.' },
{ label: 'Pressure gauge', def: 'Wellhead pressure (WHP)', text: 'The pressure sent to PRiSM.' }],
outputs: [
{ label: 'Tiles', text: 'Wellhead, bottom-hole gauge and separator pressure, the three rates, gas to oil ratio, water cut, flare gas rate.' },
{ label: 'Quality', text: 'good = fresh; stale = no update for 3 poll intervals; bad = comms error, exception or unit mismatch; — = not linked.' },
{ label: 'Alarms', text: 'HI, HIHI, LO, LOLO from the tag limits, or the simulator alarms: UNACKNOWLEDGED, acknowledged or returned to normal.' }],
verdicts: [
{ mark: '✓', match: 'points (', text: 'The trend window is a PRiSM dataset now; select **Open PRiSM**.' },
{ mark: '✗', match: 'Need at least 3 samples', text: 'Too few samples in the window: wait, or pick a longer window.' }],
example: { title: 'Form data, default simulator inputs', setup: ['**Form data**, speed 1×.'],
result: ['Wellhead {{3000|pressureG}}, separator about {{150|pressureG}}; gas {{10|gasRate|1}}, oil about {{1000|liquidRate}}, water cut 16.7 %.'],
check: { kind: 'manual', reason: LIVE } },
tips: ['In Modbus data the 3D and 2D views keep the last form values for anything not linked.'],
pitfalls: ['A value shown as — is not linked: link it on the [[modbus]] page (**Link to app variable**).'],
refs: [{ std: 'ANSI/ISA-18.2', note: 'alarm states and acknowledgement' }],
related: ['modbus', 'historian', 'prism', 'wts'],
shots: [
{ id: 'view', view: 'both', alt: 'Mini WellOS in Form data with the tiles and the process view', caption: 'The page as it opens',
callouts: [{ sel: '#wos_head [data-src="modbus"]', n: 1 }, { sel: '#wos_head [data-speed="10"]', n: 2 }, { sel: '#wos_head [data-view="2d"]', n: 3 }] },
{ id: 'modbus', view: 'desktop', target: '#wos_kpis', alt: 'Tiles fed by the Modbus simulator demo', caption: 'Modbus data from the virtual slave', setup: [{ action: 'wellosDemo' }] }]
},

modbus: {
route: 'modbus', reviewed: 'v3.3.2', reviewedSrc: '8fa4158b', units: 'field', notDocumented: [],
notice: 'Each tag reads in its own units; a linked tag is converted to field units (psig, °F, MMSCFD, bbl/d, %). Metric mode does not change this page.',
keywords: ['PLC', 'RTU', 'register', 'tag', 'bridge', 'RS-485', 'gateway', 'polling', 'scaling', 'word order'],
boldExempt: ['Test read'],
purpose: 'Connects PLCs, RTUs and gauges over Modbus TCP or RTU, scales their registers into tags and links them to the app variables.',
what: ['Add the devices, then one tag per register. A linked tag feeds [[wellos]]; the [[historian]] records it. The page is read-only unless writes are enabled, and the configuration travels in project files.'],
when: ['Before a test: map the logger, gauge or PLC registers to the app.', 'Training with no hardware: load the built-in simulator.', 'A value reads wrong: check the table, address, type and word order.'],
steps: [
{ t: 'Select **Modbus Config** in **Live Data**.', shot: 'view' },
{ t: 'No hardware yet? Select **Load simulator demo** ①: one device and 37 tags on the virtual slave.' },
{ t: 'Otherwise select **+ Add device**, one row per device ([[modbus#devices|Devices]]).' },
{ t: 'Select **+ Add tag** for each register and link it ([[modbus#tags|Tags]]).' },
{ t: 'Select **Test** at the end of the device row ②; its **Status** cell shows the result. **Test read** checks one tag.', shot: 'devs' },
{ t: 'Select **Start live monitor** to poll. **Pause polling** stops polling for every page.' },
{ t: 'Read the **Configuration summary** ③. Hover over a highlighted row for the reason.', shot: 'sum' },
{ t: 'Open [[wellos]] and set its data source to **Modbus data**.' }],
outputs: [
{ label: 'Configuration summary', text: 'Devices, tags, app variables linked, addressing, writes and polling.' },
{ label: 'Live value, Status', text: 'Scaled value in the tag units, marked stale or bad; per device idle, online or the last error.' }],
verdicts: [
{ mark: '✓', match: 'Configuration is valid', text: 'Every device and tag passed the checks.' },
{ mark: '⚠', match: 'configuration issue', text: 'Fix the highlighted rows.' },
{ mark: '✓', match: 'Simulator demo loaded', text: 'The demo replaced the configuration.' }],
example: { title: 'The simulator demo', setup: ['Select **Load simulator demo**.'],
result: ['1 device, 37 tags, 34 of 34 app variables linked.', 'The bottom-hole gauge tag is in barg; Mini WellOS shows {{5400|pressureG}}.'],
check: { kind: 'manual', reason: LIVE } },
tips: ['The virtual slave register map is a model for your own tag list.'],
pitfalls: ['A switched-off device or one without tags is not polled.'],
refs: [{ std: 'Modbus Application Protocol Specification V1.1b3', note: 'tables, function codes, exceptions' }],
related: ['wellos', 'historian'],
parts: [
{ id: 'devices', title: 'Devices', inputs: [
{ label: 'Transport', def: 'Built-in simulator (virtual slave)', text: 'WebSocket bridge (web), Web Serial (RTU) or iOS app native TCP.' },
{ label: 'Host / IP, Port', def: '502', text: 'Use the IP address, not a host name.' },
{ label: 'Unit id', def: '1', text: 'The slave address; gateways often need the RS-485 address.' },
{ label: 'Poll, Timeout', def: '1000 ms', text: 'Poll 100 ms to 60 s; stale after 3 polls without a reply.' },
{ label: 'Byte / word order', def: 'ABCD', text: 'CDAB word swap, BADC byte swap, DCBA little-endian.' }] },
{ id: 'tags', title: 'Tags', inputs: [
{ label: 'Register addressing', def: '0-based', text: '1-based uses PLC numbers: 40001 is holding register 0.' },
{ label: 'Register table, Data type', def: 'Holding, FLOAT32', text: 'Coil, discrete input, input or holding register; 16, 32 or 64 bit.' },
{ label: 'Scaling', def: 'None', text: 'Raw → Eng: a line through two points. Gain / offset: value × gain + offset.' },
{ label: 'LOLO, LO, HI, HIHI', text: 'Alarm limits for [[wellos]], with a deadband.' },
{ label: 'Link to app variable', def: '— not linked —', text: 'The app value the tag feeds; Log sends it to the [[historian]].' }] },
{ id: 'writes', title: 'Writes', steps: [
{ t: 'Tick **Enable writes (FC05 / 06 / 15 / 16)** and confirm.' },
{ t: 'Choose the **Tag to write** and a value.' },
{ t: 'Select **Write…** and confirm.' }],
inputs: [{ label: 'Tag to write', id: 'mbc_wtag_sel', text: 'Coils and holding registers only.' }],
verdicts: [{ mark: '✗', match: 'Writes are disabled', text: 'Tick **Enable writes** first.' }, { mark: '✓', match: 'Wrote', text: 'The device took the value.' }] },
{ id: 'setup', title: 'Real equipment',
what: ['Follow the **Connecting to real equipment — setup guide** card on the page: install, check, troubleshooting.'],
steps: [
{ t: 'Web: install the bridge on a PC on the device network as the card shows, then select **Check bridge**.' },
{ t: 'iOS app: transport **Modbus TCP (iOS app, native)**; no bridge.' },
{ t: 'RS-485: **Modbus RTU via Web Serial** in a desktop browser that has it; **Test** asks for the port.' }],
verdicts: [
{ mark: '✓', match: 'Any device IP / port', text: 'The bridge may reach any device; it listens on this PC only.' },
{ mark: '✓', match: 'is running at', text: 'The bridge answered.' },
{ mark: '✗', match: 'answered', text: 'No bridge answered: read the hints below it.' }] }],
shots: [
{ id: 'view', view: 'both', alt: 'Modbus Configuration with no devices', caption: 'The page as it opens', callouts: [{ sel: '#mbc_root [data-act="demo"]', n: 1 }] },
{ id: 'devs', view: 'desktop', target: '#mbc_devs', alt: 'Virtual slave device row and its status', caption: 'Devices after the demo',
setup: [{ action: 'modbusSimDemo' }], callouts: [{ sel: '#mbc_devs tr[data-row="dev"]', n: 2 }] },
{ id: 'sum', view: 'desktop', target: '#mbc_res .rbox', alt: 'Configuration summary for the demo', caption: 'Configuration summary',
setup: [{ action: 'modbusSimDemo' }], callouts: [{ sel: '#mbc_res .rbox-title', n: 3 }] }]
},

historian: {
route: 'historian', reviewed: 'v3.3.2', reviewedSrc: '27ab1ca9', units: 'field',
notice: 'Values keep the unit they were recorded in; Metric mode does not convert them.',
keywords: ['history', 'database', 'backup', 'restore', 'export', 'retention', 'rollup', 'xlsx', 'csv'],
notDocumented: [{ pattern: '^hist_', why: 'buttons, named in the steps' }],
purpose: 'Records, trends, tabulates and exports tag data from Modbus, Mini WellOS and the Well Test form, stored on this device.',
what: ['It records the [[modbus]] tags, the [[wellos]] form values, and the Well Test form while **Log form data** is ticked. Each sample is good, stale or bad; times are UTC, shown in local time.'],
when: ['Review a test, tag by tag, over hours or days.', 'Export data for a report or for PRiSM.', 'Back up before clearing a device or changing the storage engine.'],
steps: [
{ t: 'Select **Historian** in **Live Data**.', shot: 'view' },
{ t: 'No data yet? Select **Start demo data** ① or **Add 24 h of demo history**.' },
{ t: 'Set up live tags on the [[modbus]] page, or tick **Log form data**.' },
{ t: 'Under **Trend**, pick the range ② and the tags. **Custom** needs From, To and **Apply range**.' },
{ t: '**Live** follows the newest sample. Drag to pan, wheel or pinch to zoom, **Reset zoom** to go back.' },
{ t: 'Set **Values** and **Layout**; **Export PNG** saves the trend.' },
{ t: 'Read the **Data table**; page with **Next ›** or select **Copy (tab-separated)**.' },
{ t: 'Under **Export and restore**, choose format, range, tags and values, then **Export** ③.', shot: 'export' },
{ t: 'To restore, choose the file, the **Restore mode**, then **Restore**.' },
{ t: 'Under **Storage and retention**, set the limits and select **Apply retention**.' },
{ t: 'Select **Request persistent storage**: a browser may clear site data when storage is short.' }],
inputs: [
{ label: 'Values', def: 'Auto', text: 'Raw, or the average, minimum, maximum or last per bucket.' },
{ label: 'Export format', def: 'CSV, one row per sample', text: 'Or one column per tag, .xlsx, or a .sqlite / .json backup.' },
{ label: 'Restore mode', def: 'Merge into the current data', text: 'Replace deletes all current data first.' },
{ label: 'Keep data for', def: '30 days', text: '0 = for ever.' },
{ label: 'Downsample raw data older than', def: '7 days', text: 'Older raw samples become 1-minute rollups.' },
{ label: 'Storage engine', def: 'Automatic (best available)', text: 'Memory only is not saved.' }],
outputs: [
{ label: 'Historian status', text: 'Engine, samples, tags, samples waiting.' },
{ label: 'Tag logging status', text: 'Per tag: unit, samples, last value, quality, logging or not.' },
{ label: 'Table marks', text: '◌ stale, ✗ bad or none, † 1-minute mean.' }],
example: { title: 'Demo history', setup: ['On an empty historian, select **Add 24 h of demo history**.'],
result: ['Four DEMO tags, one sample every 10 s for 24 h; about 1 in 97 stale and 1 in 331 bad.'],
check: { kind: 'manual', reason: 'Asynchronous browser storage; the set follows from the page generator (4 tags, 10 s, 24 h).' } },
tips: ['Bucket values use the good samples; averages are not time-weighted.'],
pitfalls: ['**Purge** and **Delete all historian data** cannot be undone: export a backup first.'],
refs: [{ std: 'Steinarsson (2013)', note: 'downsampling of the raw trend' }],
related: ['modbus', 'wellos', 'prism'],
shots: [
{ id: 'view', view: 'both', alt: 'Historian status, demo buttons and trend card', caption: 'The page as it opens',
callouts: [{ sel: '#hist_demo_btn', n: 1 }, { sel: '#hist_root [data-seg="Time range"]', n: 2 }] },
{ id: 'export', view: 'desktop', target: '#hist_root > .card:nth-child(4)', alt: 'Export and restore card', caption: 'Export and restore', callouts: [{ sel: '#hist_export_btn', n: 3 }] }]
}

} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
