// prism-build/48-calc-help-flare.js — Help content: Flare & Relief (HELP-GUIDE-PLAN.md §4, WP-C8).
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'flare', routes: ['flare', 'flareghg', 'dispersion', 'prv', 'flamearr'], build: function () {
var MET = 'In Metric mode the page shows the same values converted; the calculation is the same.';
function I(l, id, d, t) { var o = { label: l }; if (id) o.id = id; if (d) o.def = d; if (t) o.text = t; return o; }
function O(l, t) { return { label: l, text: t }; }
function V(m, k, t) { return { mark: m, match: k, text: t }; }
function C(a) { return a.map(function (s, i) { return { sel: s, n: i + 1 }; }); }
function S(id, alt, o) { var s = { id: id, view: id === 'view' ? 'both' : 'desktop', alt: alt, caption: id === 'view' ? 'The page as it opens' : 'Results' }; for (var k in o) s[k] = o[k]; return s; }
function B(f) { return 'button[onclick="' + f + '()"]'; }
function P(n) { return { t: 'Select **' + n + '** in **Flare & Relief**.', shot: 'view' }; }
function Q(r, src, o) { o.route = r; o.reviewed = 'v3.3.2'; o.reviewedSrc = src; o.units = 'dual'; o.notDocumented = o.notDocumented || []; return o; }
return { guides: {

flare: Q('flare', '33dcd62c', {
notDocumented: [{ pattern: '^fl_(t1|t2|he|hp|np|ns)$', why: 'view tabs, step 5' }, { pattern: '^fl_bg', why: 'drawing settings, step 6' }],
purpose: 'Flame length, radiation distances and noise around a flare or burner.',
what: ['API 521 point-source method. Inputs keep their own units (MMSCFD, BTU/SCF, metres, m/s, Celsius) in both unit systems.'],
when: ['Placing the burner and exclusion zone.', 'Wind or rate changes.'],
steps: [P('Flare Simulation'), 'Enter the **Gas Flow Rate** ① and gas data.',
'Enter **Stack Tip Height** ② and **Tip Diameter**; **Exit Velocity** is calculated.',
{ t: 'Set wind and radiation; select **Calculate & Render**.', shot: 'res' },
'Switch **3D View** / **2D Elevation** ③; in 2D pick **Elevation (Side)** or **Plan (Bird’s Eye)**.',
'Optional: **+ Add** a level; **Import Drawing** a site plan.'],
inputs: [I('Gas Flow Rate', 'fl_flow', '10'), I('Net Heating Value', 'fl_nhv', '1000'), I('Molecular Weight', 'fl_mw', '20'),
I('Combustion Efficiency', 'fl_eff', '98 %'), I('Stack Tip Height', 'fl_H', '30'), I('Tip Diameter', 'fl_D', '0.5'),
I('Exit Velocity', 'fl_V', '', 'Read only.'), I('Fraction Heat Radiated', 'fl_F', '0.2'),
I('Atm. Transmissivity', 'fl_tau', '1.0'), I('Wind Speed', 'fl_W', '5'), I('Wind From', 'fl_Wd', '0', 'Degrees from north.'),
I('Ambient Temp', 'fl_Ta', '25'), I('Radiation level', 'fl_cl', '', 'Custom level.'), I('Label', 'fl_clbl'),
I('Noise Adj.', 'fl_eta', '0'), I('Ambient Noise', 'fl_ambN', '60')],
outputs: [O('Radiation', 'Radius from the flame centre; distance at grade.'), O('Noise', 'Radii.')],
example: { title: 'Defaults', setup: ['Flow 10, stack 30 m, wind 5 m/s.'],
result: ['119.67 MW; flame {{77.7|length|1}}. The 500 BTU/hr/ft² level is 34.7 m from the flame centre, “not reached” at grade.', MET],
check: { kind: 'page', calc: 'calcFlare', set: {}, expectText: ['119.67', '16.1°', 'not reached'] } },
pitfalls: ['For people at grade, read the **At grade** column.'],
refs: [{ std: 'API Standard 521' }],
related: ['flareghg', 'dispersion'],
shots: [S('view', 'Flare Simulation page', { callouts: C(['#fl_flow', '#fl_H', '#fl_t2']) }), S('res', 'Radiation results', { target: '#fl_res > .card:first-child' })]
}),

flareghg: Q('flareghg', '3289c2dd', {
notDocumented: [{ pattern: '^fe_(c\\d|i|n|co2|h2s)', why: 'composition rows' }],
purpose: 'Flared volume, heat and CO2, CH4, N2O, CO2e and SO2 for a flaring period.',
what: ['Totals for the flaring report.'],
when: ['Flaring reports.', 'Planning a clean-up.'],
steps: [P('Flare Emissions'), 'Enter **Gas to flare** ① and **Flaring duration**.',
'Set **Combustion efficiency** ② and **GWP basis**.',
'Enter the composition in mol %. Oil burned: enter **Liquid to burner** ③.',
{ t: 'Read the verdict and **Emissions**.', shot: 'res' }],
inputs: [I('Gas to flare', 'fe_qg', '{{5|gasRate}}'), I('Flaring duration', 'fe_hrs', '24'), I('Combustion efficiency', 'fe_ce', '98 %'),
I('Assume complete combustion, oxidation factor 1', 'fe_ox1'), I('GWP basis', 'fe_gwp', 'AR5'),
I('Base temperature', 'fe_tb', '{{60|temperature}}'), I('Base pressure, absolute', 'fe_pbase', '{{14.696|pressureBase}}'),
I('Gas Composition', '', '', 'Normalised to 100 %.'), I('C7+ average carbon number', 'fe_c7n', '7'),
I('Liquid to burner', 'fe_qo', '0'), I('Liquid gravity', 'fe_api', '40'), I('Carbon content, mass', 'fe_wc', '85 %')],
outputs: [O('Flared Gas', 'Volume, heat.'), O('Emissions', 'CO2, CH4, N2O, SO2, H2S, CO2e.')],
verdicts: [V('✓', 'Combustion efficiency', 'Applied.'), V('✓', 'Oxidation factor 1', 'All carbon as CO2.'),
V('⚠', 'normalised', 'Check the composition.'), V('⚠', 'Heating value', 'Lean gas.')],
verdictCases: [{ set: { fe_ox1: true } }, { set: { fe_c1: '80' } }, { set: { fe_c1: '5', fe_c2: '0', fe_c3: '0', fe_n2: '90.5' } }],
example: { title: 'Methane', setup: ['{{1|gasRate}}, 24 hr, 98 %, C1 100 %, other rows 0.'],
result: ['CO2 51.55 t; CH4 0.384 t; CO2e 62.32 t.', MET],
check: { kind: 'compute', fn: 'WTS_flareghg_compute', tol: 0.001,
input: { qg: 1, hrs: 24, ce: 98, gwp: 'ar5', tb: 60, pbase: 14.696, y: { c1: 100 }, c7n: 7 }, expect: { co2_t: 51.553, ch4_t: 0.3835, co2e_t: 62.318 } } },
pitfalls: ['Use the method your permit requires.'],
refs: [{ std: '40 CFR Part 98 Subpart W; IPCC GWP-100' }],
related: ['dispersion', 'flare'],
shots: [S('view', 'Flare Emissions page', { callouts: C(['#fe_qg', '#fe_ox1', '#fe_qo']) }), S('res', 'Emissions box', { target: '#fe_res .rbox:nth-child(2)' })]
}),

dispersion: Q('dispersion', '60076f3d', {
notDocumented: [{ pattern: '^ds_l', why: 'Exposure Limits' }],
purpose: 'Ground-level SO2 and H2S downwind of a flare or vent against IDLH, STEL and TWA.',
what: ['Gaussian plume with plume rise. Screening only.'],
when: ['Flaring sour gas.', 'An H2S vent or leak.'],
steps: [P('SO2 / H2S Dispersion'), 'Choose the **Source** ①.',
'Enter rates, heat and height, or select **Use Flare Emissions** ② or **Use H2S Safety**.',
'Enter the wind and **Stability class** ③; check the **Exposure Limits**.',
{ t: 'Select **Calculate** ④; read the verdicts.', shot: 'res' }],
inputs: [I('Source', 'ds_src', 'Flare'), I('SO2 release rate', 'ds_so2', '{{400|massRate}}'), I('H2S release rate, unburned or vented', 'ds_h2s', '{{4|massRate}}'),
I('Flare heat release, total', 'ds_heat', '{{200|powerLarge}}'), I('Heat lost as radiation', 'ds_frad', '55 %'),
I('Flare tip / vent height above grade', 'ds_hs', '{{30|length}}'), I('Use Flare Emissions', 'ds_useflare', '', 'From [[flareghg]].'),
I('Use H2S Safety', 'ds_useh2s', '', 'From [[h2sroe]].'), I('Wind speed at 10 m', 'ds_u10', '{{20|windSpeed}}'),
I('Stability class', 'ds_cls', 'D'), I('Ambient temperature', 'ds_ta', '{{68|temperature}}'), I('Exposure Limits', '', '', 'ppm.'), I('Calculate', 'ds_calc')],
outputs: [O('Plume Rise', 'Effective height.'), O('Exceedance', 'Peak ppm; from and to each limit.')],
verdicts: [V('⚠', 'Screening only', 'Always shown.'), V('✓', 'stays below', 'Below the TWA.'), V('⚠', 'exceeds the', 'Above the STEL or TWA there.'),
V('✗', 'exceeds IDLH', 'Keep people out.'), V('⚠', 'normally', 'Check the class.'), V('⚠', 'outside', 'Peak beyond the curves.')],
verdictCases: [{ set: { ds_cls: 'E', ds_heat: '5000' } }, { set: { ds_src: 'vent', ds_so2: '0', ds_h2s: '100', ds_hs: '0', ds_u10: '5', ds_cls: 'F' } }],
example: { title: 'H2S vent', setup: ['Vent, SO2 0, H2S {{100|massRate}}, {{10|length}} high, {{5|windSpeed}}, D.'],
result: ['Peak 74.6 ppm; STEL exceeded {{56|length}} to {{555|length}}.', MET],
check: { kind: 'compute', fn: 'WTS_dispersion_compute', tol: 0.002, input: { src: 'vent', so2: 0, h2s: 100, hs: 10, u10: 5, cls: 'D', ta: 68 },
expect: { 'peak.h2s.ppm': 74.57, 'exceed.h2s.stel.to_ft': 555 } } },
pitfalls: ['For a cold vent set **SO2 release rate** to 0.'],
refs: [{ std: 'NIOSH; ACGIH' }],
related: ['flareghg', 'h2sroe'],
shots: [S('view', 'Dispersion page', { callouts: C(['#ds_src', '#ds_useflare', '#ds_cls', '#ds_calc']) }),
S('res', 'H2S vent exceedance', { target: '#ds_res .rbox:nth-child(3)', setup: [{ select: { '#ds_src': 'vent' } }, { set: { '#ds_so2': '0', '#ds_h2s': '100', '#ds_hs': '10', '#ds_u10': '5' } }] })]
}),

prv: Q('prv', '9f96baf4', {
notDocumented: [{ pattern: '^prvt', why: 'tabs' }],
boldExempt: ['Check Inlet Line'],
purpose: 'Relief valve area and API 526 orifice, and the 3 % inlet loss check.',
what: ['Picks the next larger API 526 orifice.'],
when: ['Checking a relief valve.', 'Checking an inlet line.'],
steps: [P('PRV / Relief Sizing'), 'Choose the tab ①: **Gas / Vapor**, **Steam**, **Liquid** or **Inlet Line Check**.',
'Enter **Set Pressure** ②, the fluid, the load ③ and the valve type.',
{ t: 'Select **Size PRV**.', shot: 'res' }, 'On the inlet tab select **Check Inlet Line**.'],
inputs: [I('Set Pressure', 'pg_ps', '{{250|pressureG}}'), I('Overpressure', 'pg_op', '10 %'), I('Back Pressure', 'pg_pb', '{{30|pressureG}}'),
I('Relieving Temp', 'pg_t', '{{300|temperature}}'), I('Molecular Weight', 'pg_mw', '28.97'), I('Specific Heat Ratio k', 'pg_k', '1.4'),
I('Compressibility Factor Z', 'pg_z', '1.0'), I('Mass Flow Required', 'pg_w', '{{50000|massRate}}'), I('Valve Type', 'pg_vtype', 'Conventional'),
I('Rupture Disk Upstream?', 'pg_rd', 'No')],
outputs: [O('Sizing Results', 'Area and orifice.'), O('Inlet Line', 'ΔP against 3 %.')],
verdicts: [V('✓', 'PASS', 'Within 3 %.'), V('✗', 'FAIL', 'Chatter risk.')],
example: { title: 'Gas defaults', setup: ['{{250|pressureG}}, air, {{50000|massRate}}.'],
result: ['Critical flow; orifice “L (2.853 in²)”.', MET],
check: { kind: 'page', calc: 'calcPRVgas', set: {}, expectText: ['Critical (choked)', '2.5464 in²', 'L (2.853 in²)'] } },
pitfalls: ['A red note: more valves needed.'],
refs: [{ std: 'API 520 Part I; API 526' }],
related: ['sep', 'flare'],
shots: [S('view', 'PRV sizing page', { callouts: C(['#prvt1', '#pg_ps', '#pg_w']) }), S('res', 'Gas results', { target: '#pg_res', setup: [{ click: B('calcPRVgas') }] })]
}),

flamearr: Q('flamearr', '37985a3b', {
purpose: 'The smallest flame arrestor size within your pressure drop limit.',
what: ['Checks NPS 2 to NPS 12. Temperature is Celsius in both systems.'],
when: ['Choosing a vent arrestor.', 'Higher vent rate.'],
steps: [P('Flame Arrestor'), 'Enter **Gas MW** ①, **Gas Flow**, temperature, pressure.',
'Enter **Allowable ΔP** ②, **Type**, **Element Type**.', { t: 'Select **Calculate** ③.', shot: 'res' }],
inputs: [I('Gas MW', 'fa_mw', '18'), I('Gas Flow', 'fa_q', '{{500|gasRateSmall}}'), I('Temperature', 'fa_t', '30'),
I('Operating Pressure', 'fa_p', '{{0|pressureG}}'), I('Allowable ΔP', 'fa_dp', '{{1|pressure}}'), I('Type', 'fa_type', 'End-of-Line'),
I('Element Type', 'fa_elem', 'Crimped ribbon'), I('User Loss Coeff. K', 'fa_k', '', 'Maker’s K.')],
outputs: [O('Recommended', 'Smallest size.'), O('Table', 'ΔP per size.')],
example: { title: 'Defaults', setup: ['{{500|gasRateSmall}}, limit {{1|pressure}}.'],
result: ['“Recommended: 3" (End-of-Line)”.', MET],
check: { kind: 'page', calc: 'calcFlameArr', set: {}, expectText: ['Recommended: 3" (End-of-Line)', '0.751'] } },
pitfalls: ['The maker’s flow curve governs.'],
refs: [{ std: 'ISO 16852' }],
related: ['tank', 'flare'],
shots: [S('view', 'Flame Arrestor page', { callouts: C(['#fa_mw', '#fa_dp', B('calcFlameArr')]) }), S('res', 'Recommended size', { target: '#fa_res .rbox', setup: [{ click: B('calcFlameArr') }] })]
})

} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
