// Help content: Flare & Relief (HELP-GUIDE-PLAN.md §4, WP-C8).
(function () {
'use strict';
var G = typeof window !== 'undefined' ? window : globalThis, H = G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
(H.factories = H.factories || []).push({ group: 'flare', routes: ['flare', 'flareghg', 'dispersion', 'prv', 'flamearr'], build: function () {
function M(k) { return function (a) { return a.map(function (s) { var o = {}; s.split(/\|(?![^{[]*[\]}]{2})/).forEach(function (v, i) { if (v) o[k[i]] = v; }); return o; }); }; }
var L = M(['label', 'id', 'def', 'text']), O = M(['label', 'text']), V = M(['mark', 'match', 'text']), LC = ' > .cols-2 > div:first-child > .card';
function S(id, alt, t, co, su) {
var s = { id: id, view: id === 'view' ? 'both' : 'desktop', alt: alt, caption: id === 'view' ? 'The page as it opens' : alt };
if (t) s.target = t; if (su) s.setup = su;
if (co) s.callouts = co.map(function (c) { var i = c.lastIndexOf('@'); return { sel: c.slice(0, i), n: +c.slice(i + 1) }; });
return s;
}
function B(f) { return 'button[onclick="' + f + '()"]'; }
function P(n) { return { t: 'Select **' + n + '** in **Flare & Relief**.', shot: 'view' }; }
function Q(r, src, kw, std, rel, o) {
o.route = r; o.reviewed = 'v3.3.2'; o.reviewedSrc = src; o.units = 'dual'; o.keywords = kw.split(', '); o.refs = [{ std: std }]; o.related = rel.split(' ');
o.example.result.splice(1, 0, 'In Metric mode the page shows the same values converted; the calculation is the same.');
return o;
}
function N(p, w) { return { pattern: p, why: w || 'label and default on the page' }; }
return { guides: {

flare: Q('flare', '33dcd62c', 'radiation, exclusion zone, noise', 'API Standard 521', 'flareghg dispersion', {
notDocumented: [N('^fl_(t1|t2|he|hp|np|ns|mw|eff|nhv|F|V|tau|clbl|ambN)$|^fl_bg', 'tabs, drawing settings, or label and default on the page')],
purpose: 'Flame length, radiation distances and noise around a flare or burner.',
what: ['API 521 point-source method. Inputs are not converted: MMSCFD, BTU/SCF, m, m/s, Celsius.'],
when: ['Placing the burner and exclusion zone.', 'Wind or rate changes.'],
steps: [P('Flare Simulation'), 'Enter **Gas Flow Rate** ①, the gas, **Stack Tip Height** and **Tip Diameter**.',
{ t: 'Set wind and radiation; select **Calculate & Render**.', shot: 'res' },
'Switch **3D View** / **2D Elevation** ②; in 2D pick **Elevation (Side)** or **Plan (Bird’s Eye)**.',
'Optional: **+ Add** a level; **Import Drawing** for a site plan.'],
inputs: L(['Gas Flow Rate|fl_flow|10 (MMSCFD)', 'Stack Tip Height|fl_H|30 m', 'Tip Diameter|fl_D|0.5 m', 'Wind Speed|fl_W|5 m/s',
'Wind From|fl_Wd|0|Degrees.', 'Ambient Temp|fl_Ta|25 (°C)', 'Radiation level|fl_cl|15.77 kW/m²',
'Noise Adj.|fl_eta|0 (dB)|Plus for steam assist, minus if enclosed.']),
outputs: O(['API 521 Radiation Analysis Results|**Heat Release**, **Flame Length**, **Flame Tilt Angle**; each level’s radius from the flame centre and reach at grade.',
'Flare Noise Analysis|**SPL @ 50m** to **SPL @ 500m**, and the radius of each noise limit.']),
example: { setup: ['Flow 10, stack 30 m, wind 5 m/s.'],
result: ['119.67 MW; flame 23.7 m, tilt 16.1°. 500 BTU/hr/ft²: 34.7 m from the flame centre, “not reached” at grade.', 'Inputs on this page stay in their own units.'],
check: { kind: 'page', calc: 'calcFlare', set: {}, expectText: ['119.67', '23.7', '16.1°', 'not reached'] } },
pitfalls: ['For people at grade, read **At grade from stack base, downwind**.'],
shots: [S('view', 'Flare Simulation page', 0, ['#fl_flow@1', '#fl_t2@2']), S('res', 'Radiation results', '#fl_res > .card:first-child')]
}),

flareghg: Q('flareghg', '3289c2dd', 'GHG, CO2e, emissions, methane', '40 CFR Part 98 Subpart W; IPCC GWP-100', 'dispersion flare', {
notDocumented: [N('^fe_(c\\d|i|n|co2|h2s|api|wc|tb|pbase|gwp)')],
purpose: 'Flared volume, heat and CO2, CH4, N2O, CO2e and SO2 for a flaring period.',
what: ['Totals for the flaring report.'],
when: ['Flaring reports.', 'Planning a clean-up.'],
steps: [P('Flare Emissions'), 'Enter **Gas to flare** ① and **Flaring duration**.', 'Set **Combustion efficiency** ② and **GWP basis**.',
'Enter the composition in mol %. Oil burned: enter **Liquid to burner**.',
{ t: 'Select **Calculate**; read the verdicts and **Emissions**.', shot: 'res' }],
inputs: L(['Gas to flare|fe_qg|{{5|gasRate}}', 'Flaring duration|fe_hrs|{{24|time}}', 'Combustion efficiency|fe_ce|98 %',
'Assume complete combustion, oxidation factor 1|fe_ox1||No slip.', 'Liquid to burner|fe_qo|0']),
outputs: O(['Flared Gas|**Volume flared**, **Heat released**.',
'Emissions|Each gas; **Total CO2e**, **CO2e per day**, **Intensity** for reports; **Tier-1 reference** to cross-check.']),
verdicts: V(['✓|Combustion efficiency|Applied; the rest is methane slip and unburned H2S.', '✓|Oxidation factor 1|All carbon as CO2; only if your method asks.',
'⚠|normalised|Not 100 %, so scaled: check the entries.', '⚠|Heating value|Below {{300|heatingValue}} the efficiency may not be reached: add assist gas or lower it.']),
verdictCases: [{ set: { fe_ox1: true } }, { set: { fe_c1: '80' } }, { set: { fe_c1: '5', fe_c2: '0', fe_c3: '0', fe_n2: '90.5' } }],
example: { setup: ['{{1|gasRate}}, {{24|time}}, 98 %, C1 100 %, other rows 0.'], result: ['CO2 51.55 t; CH4 0.384 t; CO2e 62.32 t.'],
check: { kind: 'compute', fn: 'WTS_flareghg_compute', tol: 0.001,
input: { qg: 1, hrs: 24, ce: 98, gwp: 'ar5', tb: 60, pbase: 14.696, y: { c1: 100 }, c7n: 7 }, expect: { co2_t: 51.553, ch4_t: 0.3835, co2e_t: 62.318 } } },
pitfalls: ['Use the method your permit requires.'],
shots: [S('view', 'Flare Emissions page', 0, ['#fe_qg@1', '#fe_ce@2']),
S('res', 'Emissions box', '#fe_res .rbox:nth-child(2)')]
}),

dispersion: Q('dispersion', '60076f3d', 'H2S, SO2, plume, IDLH', 'NIOSH; ACGIH', 'flareghg h2sroe', {
notDocumented: [N('^ds_(l|h2s|heat|frad|ta|calc|hs|useh2s)')],
purpose: 'Ground-level SO2 and H2S downwind of a flare or vent against IDLH, STEL and TWA.',
what: ['Gaussian plume with plume rise. Screening only.'],
when: ['Flaring sour gas.', 'An H2S vent or leak.'],
steps: [P('SO2 / H2S Dispersion'), 'Choose the **Source** ①; enter **SO2 release rate** ②, heat and height.',
'Or select **Use Flare Emissions** or **Use H2S Safety**.',
{ t: 'Enter the wind and **Stability class** ③; check the **Exposure Limits**.', shot: 'weather' },
{ t: 'Select **Calculate**; read the verdicts.', shot: 'res' }],
inputs: L(['Source|ds_src|Flare', 'SO2 release rate|ds_so2|{{400|massRate}}|0 for a cold vent.', 'Use Flare Emissions|ds_useflare||From [[flareghg]].',
'Wind speed at 10 m|ds_u10|{{20|windSpeed}}',
'Stability class|ds_cls|D|A unstable (sun, light wind) to F stable (clear night); D overcast or windy.']),
outputs: O(['Plume Rise & Effective Height|The plume spreads from **Effective height after final rise**.',
'Ground-Level Maximum & Exceedance Distances|Peak ppm, where it occurs, and the band where each limit is exceeded.',
'Concentration vs Distance|ppm by distance: read a fence line.']),
verdicts: V(['⚠|Screening only|Always shown; design needs a site study.', '✓|stays below|No exposure zone.',
'⚠|exceeds the|Control access and monitor in the band.', '✗|exceeds IDLH|Keep people out; cut the release.',
'⚠|normally|A needs wind below {{6.7|windSpeed|1}}; B, E, F below {{11|windSpeed|0}}.', '⚠|outside|Peak beyond the curves: rough only.']),
verdictCases: [{ set: { ds_cls: 'E', ds_heat: '5000' } }, { set: { ds_src: 'vent', ds_so2: '0', ds_h2s: '100', ds_hs: '0', ds_u10: '5', ds_cls: 'F' } }],
example: { setup: ['H2S vent: SO2 0, H2S {{100|massRate}}, {{10|length}} high, {{5|windSpeed}}, D.'],
result: ['Peak 74.6 ppm; STEL exceeded {{56|length}} to {{555|length}}.'],
check: { kind: 'compute', fn: 'WTS_dispersion_compute', tol: 0.002, input: { src: 'vent', so2: 0, h2s: 100, hs: 10, u10: 5, cls: 'D', ta: 68 },
expect: { 'peak.h2s.ppm': 74.57, 'exceed.h2s.stel.to_ft': 555 } } },
pitfalls: ['Edit the limits to your site standard.'],
shots: [S('view', 'Dispersion page', 0, ['#ds_src@1', '#ds_so2@2']), S('weather', 'Weather card', '#ds_root' + LC + ':nth-child(2)', ['#ds_cls@3']),
S('res', 'Exceedance distances', '#ds_res .rbox:nth-child(3)')]
}),

prv: Q('prv', '9f96baf4', 'PSV, relief, orifice, chatter', 'API 520 Part I; API 526', 'sep flare', {
notDocumented: [N('^prvt', 'tabs'), N('^pg_(t|mw|k|z)$')],
purpose: 'Relief valve area and API 526 orifice, and the 3 % inlet loss check.',
what: ['Picks the next larger API 526 orifice.'],
when: ['Checking a relief valve.', 'Checking an inlet line.'],
steps: [P('PRV / Relief Sizing'), 'Choose the tab ①: **Gas / Vapor**, **Steam**, **Liquid** or **Inlet Line Check**.',
'Enter **Set Pressure** ② and the fluid.', { t: 'Enter the load ③ and valve; select **Size PRV**.', shot: 'load' },
{ t: 'On **Inlet Line Check**, check the line.', shot: 'inlet' }],
inputs: L(['Set Pressure|pg_ps|{{250|pressureG}}', 'Overpressure|pg_op|10 %|21 % fire case.', 'Back Pressure|pg_pb|{{30|pressureG}}',
'Mass Flow Required|pg_w|{{50000|massRate}}', 'Valve Type|pg_vtype|Conventional|Bellows or pilot for high back pressure.', 'Rupture Disk Upstream?|pg_rd|No|Adds Kc.',
'Steam tab|||**Superheat Temp** if superheated.',
'Liquid tab|||**Flow Rate**, **Specific Gravity**, **Viscosity**; **ASME Capacity Certified?** No: 1.25 × set pressure.',
'Inlet Line Check tab|||**Pipe ID**, **Pipe Length**, friction f, elbows, gate valves, **Gas Flowrate**, **Gas Density at Inlet**.']),
outputs: O(['Sizing Results|**Flow Regime**, K factors, **Required Area A**, **Selected API 526 Orifice**.',
'Inlet Line Pressure Drop|**Inlet ΔP** as % of set pressure, against 3 %.']),
verdicts: V(['✓|PASS|No chatter risk.', '✗|FAIL|Chatter risk: use a larger or shorter line, fewer fittings, or a remote-sensing pilot.']),
example: { setup: ['{{250|pressureG}}, air, {{50000|massRate}}.'], result: ['Critical flow; orifice “L (2.853 in²)”.'],
check: { kind: 'page', calc: 'calcPRVgas', set: {}, expectText: ['Critical (choked)', '2.5464 in²', 'L (2.853 in²)'] } },
pitfalls: ['A red note: above orifice T, use more valves.'],
shots: [S('view', 'PRV sizing page', 0, ['#prvt1@1', '#pg_ps@2']), S('load', 'Relief load card', '#prv_body' + LC + ':nth-child(3)', ['#pg_w@3']),
S('res', 'Gas results', '#pg_res', 0, [{ click: B('calcPRVgas') }]),
S('inlet', 'Inlet line check', '#pi_res .rbox', 0, [{ click: '#prvt4' }, { click: B('calcPRVinlet') }, { scroll: '#pi_res' }])]
}),

flamearr: Q('flamearr', '37985a3b', 'arrestor, flashback, vent', 'ISO 16852', 'tank flare', {
notDocumented: [N('^fa_(t|p|elem)$')],
purpose: 'The smallest flame arrestor size within your pressure drop limit.',
what: ['Checks NPS 2 to NPS 12. Temperature is Celsius in both systems.'],
when: ['Choosing a vent arrestor.', 'Higher vent rate.'],
steps: [P('Flame Arrestor'), 'Enter **Gas MW** ①, **Gas Flow** ②, temperature, pressure.',
'Enter **Allowable ΔP**, **Type**, **Element Type**.', { t: 'Select **Calculate**.', shot: 'res' }],
inputs: L(['Gas MW|fa_mw|18', 'Gas Flow|fa_q|{{500|gasRateSmall}}', 'Allowable ΔP|fa_dp|{{1|pressure}}', 'Type|fa_type|End-of-Line|Adds an exit head.', 'User Loss Coeff. K|fa_k||Maker’s value.']),
outputs: O(['Recommended|Smallest NPS within the limit; **ACFM**, **Gas Density**, **Element K used**.', 'Size table|ΔP per NPS; OK is within the limit.']),
example: { setup: ['{{500|gasRateSmall}}, limit {{1|pressure}}.'], result: ['“Recommended: 3" (End-of-Line)”.', 'Temperature stays in Celsius.'],
check: { kind: 'page', calc: 'calcFlameArr', set: {}, expectText: ['Recommended: 3" (End-of-Line)', '0.751'] } },
pitfalls: ['**None fit**: raise **Allowable ΔP**, change **Type** or **Element Type**, or split the flow.', 'The maker’s flow curve governs.'],
shots: [S('view', 'Flame Arrestor page', 0, ['#fa_mw@1', '#fa_q@2']),
S('res', 'Recommended size', '#fa_res .rbox', 0, [{ click: B('calcFlameArr') }])]
})

} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
