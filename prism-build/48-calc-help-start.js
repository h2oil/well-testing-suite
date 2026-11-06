// prism-build/48-calc-help-start.js — Help content: Getting started, "How do I…" tasks, glossary, FAQ and the keyboard
// appendix (docs/HELP-GUIDE-PLAN.md §4.7, §4.8, WP-C1). Data only (no WTS_calcRegistry page); the factory runs on the first Help open.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'start', routes: [], build: function () {
function L(a) { return { list: a }; }
function O(a) { return { list: a, ordered: true }; }
function S(route, t, carry) { var s = { t: t }; if (route) s.route = route; if (carry) s.carry = carry; return s; }
var start = [
{ id: 'open', title: 'Opening the app', body: [
'Use the web version at {{site}}, or the free iOS app. Both have every module, and every calculation runs on your device.',
'On the web the app works offline after the first visit. When a newer version is found, a bar offers **Reload**.',
'Your inputs stay in this browser’s storage, or in the iOS app on the device. Nothing is sent to a server: see [[privacy]].'] },
{ id: 'screen', title: 'The screen', shots: [
{ id: 'screen', view: 'desktop', alt: 'The app with the sidebar on the left, the header tools at the top and the Dashboard', caption: 'Sidebar, header tools and Dashboard',
callouts: [{ sel: '#sb_search', n: 1 }, { sel: '#wts_well_host', n: 2 }, { sel: '#wts_project_toolbar_host', n: 3 }, { sel: '#wts_unit_toggle_host', n: 4 }, { sel: '#wts_quick_report_host', n: 5 }] },
{ id: 'header', view: 'desktop', target: '.page-actions', alt: 'Header tools: Well menu, File, Units, Std and Quick Report', caption: 'The header tools' }], body: [
{ shot: 'screen' },
L(['**Sidebar**: nine groups. Select a group heading to open it; one group is open at a time. The search box ① finds a page by name.',
'**Hubs**: one sidebar row, such as Chokes or Separators, stands for several pages. Tabs above the page switch between them.',
'**Dashboard**: search, favourites ★, recently used pages and a tile for every module ([[home]]).',
'**Well** ②: the active well and the Well menu ⋯ ([[start#wells|Several wells]]).',
'**File** ③: New, Open…, Save and Save As… for project files ([[start#saving|Saving work]]).',
'**Units** ④: Imperial or Metric, the decimal comma 1,5 and the Std base conditions ([[start#units|Units]]).',
'**Quick Report** ⑤: one PDF of every page you have run ([[start#reports|Reports]]).',
'**Export buttons**: Copy results, PDF, PNG, CSV and JSON for the page on screen.']),
{ shot: 'header' }] },
{ id: 'first', title: 'Your first calculation', shots: [
{ id: 'first', view: 'desktop', route: 'oilgas', target: '#og_res', alt: 'Combined Results box of Oil & Gas Rate with the example inputs', caption: 'Oil & Gas Rate: the results for the example inputs',
setup: [{ click: 'button[onclick="calcOilGas()"]' }, { waitFor: '#og_res .rbox' }] }], body: [
O(['Open **Production & Reservoir** in the sidebar and select **Oil & Gas Rate**.',
'The page opens with example inputs: a 60 min interval, meter readings {{1000|volume}} and {{1004.5|volume}}, 35 °API, separator {{500|pressureG}}, {{50|pressureSmall60}} on a {{2|lengthSmall}} plate.',
'Select **Calculate**. **Combined Results** shows Oil Rate {{97.7|liquidRate|1}}, Gas Rate {{3792.554|gasRateSmall|3}} and GOR {{38809|gor|0}} (the page writes the GOR unit as scf/bbl).',
'Change an input and select **Calculate** again. Your inputs are saved as you type.',
'Use the export buttons for a PDF of the page, or **Copy results** for the text.']),
{ shot: 'first' },
'In Metric mode the page shows the same values converted; the calculation is the same.'] },
{ id: 'saving', title: 'Saving work', body: [
L(['**Autosave**: each page keeps its inputs on this device as you type. The header shows Autosave on, then the time of the last save.',
'**Project files** (.h2oilproj): **File → Save** puts every page’s inputs, Client & Well Info, every well, the PRiSM data and the report snapshots in one file. **Open…** loads it on any device with the app. **Save As…** writes a copy under a new name.',
'**File → New** clears every page for a new job. It keeps your device settings and the Report Prepared By fields.',
'Device settings are not in project files: the units system, the decimal comma, favourites and the open sidebar group.']),
'Fill in [[clientinfo]] first: its details go on every report.'] },
{ id: 'wells', title: 'Several wells', body: [
'A project can hold several wells. Each well keeps its own inputs and results; every page shows the active well.',
L(['**Well menu** (⋯ next to the well name): New well…, Duplicate this well…, Rename…, Delete this well….',
'**Copy this page’s inputs from**: copies the page on screen from another well.',
'**Compare wells** opens [[wells]].',
'**Share read-only snapshot**: This page, Job report (this well) or All wells comparison, as a read-only HTML file.']),
'A project always has at least one well. Deleting a well cannot be undone unless you saved a project file.'] },
{ id: 'units', title: 'Units and base conditions', body: [
'Every calculation runs in oilfield (imperial) units. **Metric** converts what you type and what you read; **Imperial** goes back. Labels change with the setting, so the guides quote labels without their unit.',
L(['**Std** sets the base (standard) conditions for gas volumes. “calc default” keeps each page’s own basis; the other choices are 60 °F at 14.696, 14.65 or 14.73 psia, and 15 °C or 0 °C at 101.325 kPa.',
'**1,5** turns on the decimal comma: 12,5 typed in a number field is read as 12.5. While it is on, 1,500 means 1.5.',
'PRiSM works in oilfield units only, and says so at the top of the page in Metric mode.'])] },
{ id: 'reports', title: 'Reports', body: [
L(['**Export buttons** on each calculator page: **Copy results** (text; tables tab-separated), **PDF**, **PNG** (charts), **CSV** and **JSON** of the inputs and results.',
'The PDF opens a print-ready page; use your browser’s print to save it as a PDF file.',
'**Quick Report**: one PDF of every page you have calculated. Its ▾ picks a template: All captured pages, Daily well-test report, Final well-test report, or your own (New template).',
'The client logo is used only when it is ticked in [[clientinfo]].'])] },
{ id: 'jobs', title: 'Jobs that use several pages', body: [
'[[tasks|How do I…]] lists common jobs step by step, with what to carry from one page to the next.',
{ h: 'Live data in one page' },
'Connect the gauges in [[modbus]], watch them in [[wellos]], keep and export the history in [[historian]], then load the exported series in [[prism]] ([[task#live|the steps]]).'] },
{ id: 'keyboard', title: 'Keyboard and accessibility', body: [
{ table: { head: ['Key', 'Where', 'What it does'], rows: [
['F1', 'any page', 'Opens the guide for that page'],
['/', 'Help', 'Moves to the search box'],
['↑ ↓, Enter, Esc', 'Help search', 'Move through the results, open one, clear the search'],
['Tab', 'everywhere', 'Next control; the sidebar is one Tab stop'],
['↑ ↓ Home End, Enter', 'sidebar', 'Move between pages, open one'],
['← → Home End', 'tab strips', 'Move between tabs'],
['Enter, Esc', 'Dashboard search', 'Open the first match, clear the search'],
['?', 'Well Test Simulator', 'Its own key list: Space play or pause, R reset, E trip the ESD, V 2D or 3D, A acknowledge all']] } },
'Tiles and other click-only items take Enter or Space. Screen readers announce new results. The decimal comma is in [[start#units|Units]].'] },
{ id: 'trouble', title: 'Troubleshooting', body: [
L(['**A page keeps odd values**: there is no reset for one page. Change the values back, or use File → New for a clean job (save a project file first). A new well (Well menu → New well…) also starts with empty pages; delete it afterwards if you only needed a clean page.',
'**Clearing site data** in your browser’s site settings removes everything the app stored on this device. Save a project file first.',
'**The 3D view stays blank**: it needs graphics support and, on the web, downloads its engine on first use. Use the 2D view.',
'**Opening a file on iOS**: save the file in the Files app first, then pick it there.',
'**Where your data is**: in this browser’s storage on this device ([[privacy]]); project files and exports go where you save them.',
'**Contact**: {{email}}.']),
'More answers: [[faq|Troubleshooting and FAQ]].'] }];

var tasks = [
{ id: 'spread', title: 'Design a well test spread', purpose: 'Size the surface spread for the expected rates.', steps: [
S('clientinfo', 'Client, well and rig.'),
S('wts', 'Enter the rates, pressures and bean; read velocities and hydrate margins.', 'gas, oil and water rates; wellhead pressure; separator pressure'),
S('choke', 'Check the bean and critical flow.', 'bean size'),
S('sep', 'Retention time at the test rates.', 'separator size'),
S('flare', 'Radiation at the burner for the gas rate.', 'flare radiation'),
S('prv', 'Relief load and orifice.', 'relief load'),
S('', 'Quick Report ▾ → Final well-test report.')] },
{ id: 'cleanup', title: 'Clean up and unload the cushion', purpose: 'Unload the completion fluid to the burner, then go through the separator.', steps: [
S('wts', 'Follow field scenario [[fs#FS-1|FS-1]]: it sets the simulator up for an unload to the burner.', 'unload rate and gas rate'),
S('flare', 'Radiation at the burner for that gas rate.', 'burner back pressure'),
S('dispersion', 'Where the burner gas and the hydrogen sulphide (H2S) in it go downwind.'),
S('hydrate', 'Hydrate risk downstream of the choke.', 'choke outlet pressure and temperature'),
S('cheminj', 'Inhibitor rate and pump setting, if needed.')] },
{ id: 'metergas', title: 'Meter gas', purpose: 'Pick the plate, measure the rate and check the meters.', steps: [
S('orifice', 'The plate that keeps the differential pressure (DP) inside the transmitter range.', 'plate bore and DP range'),
S('aga3', 'Gas rate from the readings.', 'gas rate'),
S('proving', 'Liquid meter factor from the prover runs.', 'meter factor'),
S('sepqc', 'Separator GOR and sample checks.')] },
{ id: 'daily', title: 'Prepare the daily report', purpose: 'One PDF for the day.', steps: [
S('wells', 'Make sure the right well is active.'),
S('clientinfo', 'Check the header details and select Save Information.'),
S('', 'Calculate the day’s pages: each calculation is captured for the report.', 'snapshots'),
S('', 'Quick Report ▾ → Daily well-test report.')] },
{ id: 'hydrate', title: 'Check hydrate risk at the choke', purpose: 'Find the cold point and protect it.', steps: [
S('wts', 'Choke outlet pressure and temperature (or [[choke]]).', 'choke outlet P and T'),
S('hydrate', 'Hydrate margin per segment and inhibitor rate.', 'hydrate margin'),
S('cheminj', 'Pump and injection point for the inhibitor.', 'inhibitor rate')] },
{ id: 'buildup', title: 'Interpret a build-up', purpose: 'Get permeability k, skin and the extrapolated pressure p* from a shut-in.', steps: [
S('buildup', 'Find and interpret the shut-ins in gauge data.', 'rate history; producing time'),
S('prism', 'Or step by step: Data, Flow periods, Diagnose, Model & fit, Report.', 'k, skin, p*')] },
{ id: 'erosion', title: 'Size a flowline or check erosion', purpose: 'Pressure drop, velocity and sand erosion.', steps: [
S('flowline', 'Pressure drop and velocities along the line.', 'rates; velocities'),
S('pipesz', 'Pipe size for the velocity limits.', 'velocity against the API RP 14E limit'),
S('pipelife', 'Sand erosion time per segment.')] },
{ id: 'kill', title: 'Plan a well kill', purpose: 'Kill fluid and volumes.', steps: [
S('wellkill', 'Kill weight and bullhead volumes.', 'kill weight; volumes'),
S('complfluids', 'Brine blend for that weight; cement slurry volumes if needed.')] },
{ id: 'live', title: 'Live data from a gauge', purpose: 'From the gauge to an interpretation.', steps: [
S('modbus', 'Connect the device and set up the tags.', 'tags'),
S('wellos', 'Watch the live values and alarms.'),
S('historian', 'Keep the history and export it.', 'exported series'),
S('prism', 'Load the series and interpret it.')] },
{ id: 'gasprops', title: 'Gas properties for a calculation', purpose: 'Z and related properties at line conditions.', steps: [
S('gaspvt', 'Z, k, viscosity and J-T coefficient at the line pressure and temperature.', 'Z, k, J-T coefficient'),
S('', 'Enter them on the page that needs them.')] }];

var glossary = {
bean: { term: 'bean', variants: ['beans'], def: 'A fixed choke. Its size is the bore in 64ths of an inch: a 32 bean is 32/64 in.' },
bsw: { term: 'BS&W', variants: ['basic sediment and water'], def: 'Basic sediment and water: the water and solids in the oil, in % of volume.' },
cushion: { term: 'cushion', variants: ['cushions', 'water cushion', 'nitrogen cushion'], def: 'A liquid column (water, brine or diesel) or nitrogen placed in the test string above the tester valve. It limits the drawdown and the collapse load when the valve opens. It is unloaded first, usually to the burner.' },
skin: { term: 'skin', variants: ['skin factor', 'mechanical skin'], def: 'A dimensionless number for the extra pressure drop near the wellbore. Positive: damage. Negative: a stimulated well.' },
critical: { term: 'critical (sonic) flow', variants: ['choked flow', 'sonic flow'], def: 'Flow through a choke at sonic speed, below a P2/P1 of about 0.55. The rate then does not depend on the downstream pressure.' },
iarf: { term: 'IARF', variants: ['infinite-acting radial flow', 'radial flow'], def: 'Infinite-acting radial flow: the flat part of the derivative. Permeability and skin come from it.' },
pstar: { term: 'p*', variants: ['p star', 'extrapolated pressure'], def: 'The pressure the semilog straight line of a build-up reaches at infinite shut-in time (Horner time ratio of 1).' },
fwhp: { term: 'FWHP', variants: ['FTHP', 'WHP'], def: 'Flowing wellhead (tubing) pressure, upstream of the choke.' },
sithp: { term: 'SITHP', variants: ['SIWHP'], def: 'Shut-in tubing (wellhead) pressure with the well closed in.' },
gor: { term: 'GOR', def: 'Gas-oil ratio: standard gas volume per stock-tank barrel of oil.' },
psv: { term: 'PSV', def: 'Pressure safety (relief) valve: opens at its set pressure to protect a vessel or line.' } };

var faq = [
{ id: 'pressure', q: 'Which pressure goes where in the Well Test Simulator?', a: [L([
'Flowing wellhead or tubing pressure: **Wellhead Pressure**, never the separator pressure.',
'Production or export line pressure: the separator **Operating Pressure**, with V-101 in; add the line loss to the header.',
'Cushion or clean-up straight to the burner: set the simulator up as field scenario [[fs#FS-1|FS-1]] says.']),
'The steps and the checks are in FS-1 and the [[wts]] guide.'] },
{ id: 'training', q: 'Is there training for the simulator?', a: [
'Help has a self-paced [[course|Well Test Simulator course]]. Each exercise has answers, trainer notes and a worksheet, so a supervisor can run it for a crew.',
'Questions about training: {{email}}.'] },
{ id: 'sand', q: 'Can the simulator train sand handling and a second surge tank?', a: [
'Yes. Switch the optional DS-101 desander and T-202 second surge tank in, in the **Rig-up** card ([[wts]]), then follow [[course#ex9|exercise 9]], [[course#ex10|exercise 10]] and field scenario [[fs#FS-3|FS-3]].'] },
{ id: 'saved', q: 'Is my work saved?', a: ['Yes, on this device, as you type. To keep a copy or move it, save a project file ([[start#saving|Saving work]]).'] },
{ id: 'device', q: 'How do I move my work to another device?', a: ['File → Save on the first device, then File → Open… on the other one.'] },
{ id: 'metric', q: 'Why does a value change when I select Metric?', a: ['It is the same value converted. Calculations always run in oilfield units ([[start#units|Units]]).'] },
{ id: 'header', q: 'Why is the client name missing from my report?', a: ['Select **Save Information** in [[clientinfo]]: reports use the saved details.'] },
{ id: 'offline', q: 'Does the app work offline?', a: ['Yes. The web version works offline after the first visit; the iOS app always does. A few optional parts download a code library the first time they are used.'] },
{ id: 'restart', q: 'How do I start again?', a: ['Save a project file, then File → New. A new well also starts with empty pages.'] },
{ id: 'contact', q: 'Who do I contact?', a: ['{{email}}. Please quote the version shown under the logo.'] }];
return { start: start, tasks: tasks, glossary: glossary, faq: faq };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
