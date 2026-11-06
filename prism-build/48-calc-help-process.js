// Help content: Separation & Process (docs/HELP-GUIDE-PLAN.md §4, WP-C7). Data only.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'process', routes: ['sep', 'seprate', 'sephand', 'heater', 'vessel', 'tank', 'pumpsz', 'arc', 'aircomp'], build: function () {
function I(l, id, d, t) { var o = { label: l, id: id }, m; if (d) { o.def = d; m = /\{\{[^|]+\|(\w+)/.exec(d); if (m) o.cat = m[1]; } if (t) o.text = t; return o; }
function O(l, t) { return { label: l, text: t }; }
function V(n, cs) { return [{ id: 'view', view: 'both', alt: n + ' page with the default inputs', caption: 'The page as it opens', callouts: cs.map(function (s, i) { return { sel: s, n: i + 1 }; }) }]; }
function S(r, src, kw) { return { route: r, reviewed: 'v3.3.2', reviewedSrc: src, units: 'dual', keywords: kw }; }
function A(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
function P(fn, set, x) { return A({ kind: 'page', calc: fn, set: set || {} }, x); }
function F(t) { return { t: 'Select **' + t + '** in **Separation & Process**.', shot: 'view' }; }
function H(t) { return { t: 'Select **Separators** in **Separation & Process**, then **' + t + '**.', shot: 'view' }; }
function C(set) { return { set: set, calc: 'calcSepHandling' }; }
var NU = 'Not used in the calculation.', CALC = 'Select **Calculate**. Read ', DC = 'Degrees Celsius.', DEF = 'The default inputs';
var J12 = { std: 'API Spec 12J', note: 'oil and gas separators' }, P610 = { std: 'API 610 / ISO 13709', note: 'centrifugal pumps, minimum flow' };
var g = {};

g.sep = A(S('sep', 'a8436816', ['retention', 'residence time']), {
purpose: 'Estimates how long liquid stays in the separator from its capacity, the liquid level and the flow rate.',
what: ['Retention time is the liquid held divided by the liquid rate. On a horizontal vessel a gauge reads height; the page can turn a level in % of the ID into % of volume.'],
when: ['Before a test, at the expected liquid rate.', 'When the rate or the level set point changes.'],
steps: [H('Separator Retention'), 'Enter the **Separator Capacity** ① and the **Fluid Level** ②; choose the **Level Basis** ③.',
'Enter the liquid **Flow Rate** ④: oil plus water.', CALC + 'the time and status; compare them with the **Guidelines**.'],
inputs: [I('Separator Capacity', 'sp_cap', '{{17.4|volume}}'), I('Fluid Level', 'sp_lvl', '50 %'), I('Level Basis', 'sp_basis', 0, '% of ID height for a gauge on a horizontal vessel.'), I('Flow Rate', 'sp_q', '{{6600|liquidRate}}')],
outputs: [O('Retention Time', 'In mm:ss and minutes.'), O('Status', 'ADEQUATE from 3 minutes, LOW from 1, CRITICALLY LOW below: raise the level or cut the rate.')],
example: { title: DEF, setup: ['{{17.4|volume}} at 50 %, {{6600|liquidRate}}.'], result: ['{{8.7|volume|1}} held; 1.9 minutes: LOW — May be insufficient.'],
check: P('calcSepRetention', 0, { expectIds: { sp_res: 8.7 }, expectText: ['1.9 minutes', 'LOW — May be insufficient'] }) },
tips: ['More level or less rate gives more time; then check the gas on [[seprate]].'], pitfalls: ['A 25 % level by height is 19.6 % of a horizontal vessel.'],
refs: [J12], related: ['seprate', 'sephand', 'sepqc'],
shots: V('Separator Retention', ['#sp_cap', '#sp_lvl', '#sp_basis', '#sp_q']) });

g.seprate = A(S('seprate', '31e7e713', ['Souders-Brown', 'gas capacity']), {
purpose: 'Rates a separator: Souders-Brown gas capacity and liquid retention against a target, with one PASS or FAIL.',
what: ['K follows the orientation and foaming. Gas flows above the liquid in a horizontal vessel, through the full bore in a vertical one. Water is added from the [[glossary#bsw|BS&W]]. The retention target is 3, 5 or 10 minutes for low, medium or high foaming. Z is taken as 0.9.'],
when: ['Before a test, at the expected gas and oil rates.', 'When the rates rise or the fluid foams.'],
steps: [H('Separator Rating'), 'Enter **Separator Details** ① and **Fluid Data**.', 'Set the **Foaming Tendency**: it sets K and the target.', CALC + 'PASS or FAIL, then any red row.'],
inputs: [I('Orientation', 'sr_orient'), I('Separator ID', 'sr_id', '{{36|lengthSmall}}'), I('Seam-to-Seam Length', 'sr_len', '{{10|length}}'), I('Normal Liquid Level', 'sr_nll', '50 %', '% of the ID height.'),
I('Operating Pressure', 'sr_p', '{{500|pressureG}}'), I('Temperature', 'sr_t', '{{100|temperature}}'), I('Oil Rate', 'sr_qo', '{{3000|liquidRate}}'),
I('Gas Rate', 'sr_qg', '{{5|gasRate}}'), I('Oil API Gravity', 'sr_api'), I('Gas SG', 'sr_gsg'), I('BS&W', 'sr_bsw'), I('Foaming Tendency', 'sr_foam')],
outputs: [O('Actual Gas Velocity', 'EXCEEDS LIMIT: larger ID or less gas.'), O('Retention Time', 'Short: a longer vessel or less liquid.')],
example: { title: 'Defaults, then a longer vessel', setup: ['{{36|lengthSmall}} × {{10|length}}, {{500|pressureG}}, {{3000|liquidRate}}, {{5|gasRate}}; then {{15|length}}.'],
result: ['Gas OK, but retention short of 3 minutes: FAIL.', 'At {{15|length}}: 3.11 minutes, PASS.'],
check: P('calcSepRate', { sr_len: '15' }, { expectText: ['Separator Rating — PASS', '3.11 min'] }) },
tips: ['Low pressure tends to fail the gas check; high liquid rates fail retention.'], pitfalls: ['For Z from the gas gravity and the outlets, use [[sephand]].'],
refs: [J12], related: ['sep', 'sephand', 'gascalc'],
shots: V('Separator Rating', ['#sr_orient']) });

g.sephand = A(S('sephand', 'edc0b8df', ['outlet velocity', 'Cv', 'slug', 'PCV']), {
purpose: 'Screens a separator and its outlets: gas capacity, retention, slug volume, outlet velocities and valve Cv.',
what: ['K is ×1.5 with a mesh pad; retention is split between oil and water by the [[glossary#bsw|BS&W]]. Each outlet valve, line and bore is checked against your limit and the API RP 14E erosional velocity.',
'Temperature is in degrees Celsius and the limits in m/s on both unit settings.'],
when: ['Before rig-up: check the vessel, valve and line sizes.', 'After a FAIL on [[seprate]].'],
steps: [H('Separator Handling'), 'Fill **Configuration** ①, **Operating Conditions** and **Fluids**.', 'Enter the outlet sizes; 0 = no orifice fitting or turbine.',
'Check **Velocity & Cv Limits**, then select **Calculate**.', { t: 'Read the verdict ② and each ✗ and ⚠ line; apply the Recommendation lines.', shot: 'res' }],
inputs: [I('Service', 'sh_service'), I('Orientation', 'sh_orient'), I('Internals Type', 'sh_internals', 0, NU), I('Mist Eliminator', 'sh_mist'),
I('Separator ID', 'sh_id', '{{42|lengthSmall}}'), I('Seam-to-Seam Length', 'sh_len', '{{12.5|length}}'), I('Normal Liquid Level', 'sh_nll'), I('High-High Level', 'sh_hhll'),
I('Oil Section', 'sh_oilfrac'), I('Operating Pressure', 'sh_p', '{{500|pressureG}}'), I('Downstream Pressure', 'sh_pd', '{{100|pressureG}}', 'After the PCV.'),
I('Temperature', 'sh_t', '40', DC), I('Z-factor', 'sh_zmode'), I('Z', 'sh_zman', 0, 'Manual override only.'), I('Liquid Rate Basis', 'sh_qbasis'),
I('Liquid Rate', 'sh_qo', '{{3000|liquidRate}}'), I('Gas Rate', 'sh_qg', '{{5|gasRate}}'), I('Gas SG', 'sh_gsg'), I('Oil API', 'sh_api'), I('BS&W', 'sh_bsw'),
I('Foaming Tendency', 'sh_foam'), I('Emulsion Tendency', 'sh_emul'), I('PCV size', 'sh_gpcv', '{{2|lengthSmall}}'), I('Line size', 'sh_gline', '{{3|lengthSmall}}'),
I('Gas line/PCV limit', 'sh_vlimg', '20 m/s'), I('Liquid line/LCV limit', 'sh_vliml', '3 m/s'), I('Turbine bore warn', 'sh_vlimt', '6 m/s'), I('Orifice fitting limit', 'sh_vlimd', '20 m/s'),
I('LCV ΔP design', 'sh_dplcv', '{{25|pressure}}'), I('Target valve travel', 'sh_travel')],
notDocumented: [{ pattern: '^sh_[gow](qty|pcv|lcv|line|turb|dan)$', why: 'other outlet sizes, alike' }],
outputs: [O('Verdict', 'PASS, PASS WITH WARNINGS or FAIL.'), O('Outlet Velocity Checks', 'Each outlet against both limits.'), O('Required Cv', 'Pick a valve with at least this Cv.'), O('Sensitivity', 'At ±20 % rates.')],
verdicts: [{ mark: '✗', match: 'exceeds Souders-Brown', text: 'Gas too fast: larger ID, mesh pad or less gas.' }, { mark: '✗', match: 'retention', text: 'Retention short: longer vessel or less liquid.' },
{ mark: '✗', match: ' > limit ', text: 'Outlet too fast: upsize it or add a line.' }, { mark: '⚠', match: 'erosional', text: 'Above erosional: upsize the line or split the flow.' },
{ mark: '⚠', match: 'turbine warn', text: 'Use a larger meter bore.' }, { mark: '⚠', match: '4-phase service', text: 'Screened as 3-phase: check solids separately.' }, { mark: '⚠', match: 'slug capacity is zero', text: 'Raise the HHLL above the NLL.' }],
verdictCases: [C({}), C({ sh_qg: '60' }), C({ sh_qg: '5', sh_qo: '6000', sh_bsw: '60', sh_service: '4', sh_hhll: '50', sh_vlimt: '2' }), C({ sh_service: '2' }), C({ sh_vlimg: '60', sh_gpcv: '4' })],
example: { title: 'Fixing the defaults', setup: ['{{500|pressureG}} to {{100|pressureG}}, {{3000|liquidRate}}, {{5|gasRate}}; then PCV size and Line size {{6|lengthSmall}}.'],
result: ['Defaults: FAIL, the gas PCV and line above 20 m/s.', 'At {{6|lengthSmall}}: PASS.'],
check: P('calcSepHandling', { sh_service: '3', sh_qo: '3000', sh_bsw: '20', sh_hhll: '80', sh_vlimt: '6', sh_vlimg: '20', sh_gpcv: '6', sh_gline: '6' }, { expectText: ['Verdict — PASS'], absentText: ['PASS WITH WARNINGS'] }) },
tips: ['A PASS that fails at +20 % has little margin.'], pitfalls: ['A screening check: confirm the design with the supplier.'],
refs: [J12, { std: 'API RP 14E', note: 'erosional velocity' }], related: ['seprate', 'sep', 'turbmeter'],
shots: V('Separator Handling', ['#sh_service']).concat([{ id: 'res', view: 'desktop', target: '#sh_res > .rbox:first-child', setup: [{ click: '#pgBody .btn-primary' }],
alt: 'Verdict box for the default inputs', caption: 'The verdict', callouts: [{ sel: '#sh_res .rbox-title', n: 2 }] }]) });

g.heater = A(S('heater', 'f844ff57', ['line heater', 'water bath', 'diesel']), {
purpose: 'Estimates the heat duty, fired duty and diesel use of a water bath (indirect) heater.',
what: ['Fired duty is the duty divided by the efficiency; diesel is 138,000 Btu per US gallon.'],
when: ['Before a test: size the heater.', 'To estimate the diesel for the test.'],
steps: [F('Indirect Heater'), 'Enter the **Liquid Rate** ①, oil plus water, and its **Water Cut**.', 'Enter the **Inlet Temperature** and **Outlet Temperature** ②.', CALC + 'the fired duty, diesel and category.'],
inputs: [I('Liquid Rate', 'ih_q', '{{5000|liquidRate}}'), I('API Gravity', 'ih_api'), I('Inlet Temperature', 'ih_ti', '20', DC), I('Outlet Temperature', 'ih_to', '65', DC),
I('Water Cut', 'ih_wc'), I('Heater Efficiency', 'ih_eff'), I('Burners', 'ih_burn', 0, 'Dual adds a Per Burner row (half each).')],
outputs: [O('Fired Duty', 'Duty divided by the efficiency.'), O('Diesel Consumption', 'Per hour.'), O('Category', 'By fired duty.')],
example: { title: DEF, setup: ['{{5000|liquidRate}}, 30 % water, 20 to 65 degrees Celsius.'], result: ['Fired 4.376 MMBtu/hr, diesel 31.71 gal/hr: Large.'],
check: P('calcHeater', 0, { expectText: ['4.376 MMBtu/hr', '31.71 gal/hr', 'Large'] }) },
tips: ['Gas through the coil needs extra duty.'], pitfalls: ['The temperatures stay in degrees Celsius in Imperial mode.'],
refs: [{ std: 'API Spec 12K', note: 'indirect heaters' }], related: ['hydrate', 'lineheat', 'fluid'],
shots: V('Indirect Heater', ['#ih_q', '#ih_ti']) });

g.vessel = A(S('vessel', '81e94b34', ['wall thickness', 'shell', 'head']), {
purpose: 'Finds the minimum wall thickness of a cylindrical shell and of a 2:1 elliptical head under internal pressure.',
what: ['Shell t = P·R / (S·E − 0.6·P); head t = P·D / (2·S·E − 0.2·P); both corroded, plus the allowance. The shell also checks its thin-wall limits.'],
when: ['Checking a vessel or spool for a design pressure.', 'Comparing a measured wall with the minimum.'],
steps: [F('Vessel & Pipe'), 'In **Cylindrical Shell — ASME** enter the **Design Pressure** ① and the other fields.', 'Select **Calculate Shell** ②. Read the walls and the validity line.',
'For a head, fill **2:1 Elliptical Head — ASME** and select **Calculate Head**.'],
inputs: [I('Design Pressure', 'vs_p', '{{1440|pressure}}'), I('Inside Radius', 'vs_r', '{{24|lengthSmall}}'), I('Allowable Stress', 'vs_s', '{{17500|pressure}}', 'From the code table.'),
I('Joint Efficiency', 'vs_e', 0, '0 to 1.'), I('Corrosion Allowance', 'vs_ca', '{{0.125|lengthSmall}}'), I('Design Pressure', 'vh_p', 0, 'Head card.'), I('Inside Diameter', 'vh_d', '{{42|lengthSmall}}'),
I('Allowable Stress', 'vh_s'), I('Joint Efficiency', 'vh_e'), I('Corrosion Allowance', 'vh_ca')],
outputs: [O('Min Wall (with CA)', 'The minimum to accept.')],
verdicts: [{ mark: '✓', match: 'Within limits', text: 'The thin-wall formula applies.' }, { mark: '✗', match: 'Outside thin-wall limits', text: 'Use the thick-wall rules.' }],
verdictCases: [{ set: {}, calc: 'calcVesselShell' }, { set: { vs_s: '3000' }, calc: 'calcVesselShell' }],
example: { title: 'The default shell', setup: ['{{1440|pressure}}, {{24|lengthSmall}} radius, {{17500|pressure}}, allowance {{0.125|lengthSmall}}.'], result: ['✓ {{2.2132|lengthSmall|4}} with the allowance.'],
check: P('calcVesselShell', { vs_s: '17500' }, { expectText: ['2.2132 in', '✓ Within limits'] }) },
tips: ['The allowance is added to the radius too.'], pitfalls: ['Use the code stress, not the yield.'],
refs: [{ std: 'ASME BPVC Section VIII Division 1', note: 'UG-27, UG-32' }], related: ['pipelife', 'pipesz', 'prv'],
shots: V('Vessel and Pipe', ['#vs_p', '#pgBody .btn-primary']) });

g.tank = A(S('tank', '7ead2018', ['strapping', 'gauge tank', 'dip']), {
purpose: 'Tank volumes, fill % and strapping factors, a rate from two tank readings, and the deck loading of a full tank.',
what: ['Five cards, each with its own Calculate button. A horizontal tank strapping factor changes with level: it is given at your level and as an average.'],
when: ['Gauging a gauge or surge tank in a test.', 'Checking a meter against the tank.'],
steps: [F('Tank Calculator'), 'Fill the card for the shape ①, for example **Rectangular Tank**, and select **Calculate**.',
'For a rate, fill **Tank Rate Estimation** and select **Calculate Rate**.', 'For the deck, fill **Tank Weight & Deck Loading**.'],
inputs: [I('Height', 'tr_h'), I('Length', 'tr_l'), I('Width', 'tr_w'), I('Fluid Level', 'tr_fl'), I('Diameter', 'tv_d'), I('Height', 'tv_h'), I('Fluid Level', 'tv_fl'),
I('Diameter', 'tc_d'), I('Length', 'tc_l'), I('Fluid Level', 'tc_fl'), I('Initial Volume', 'tk_v1'), I('Final Volume', 'tk_v2'), I('Start Time', 'tk_t1', 0, 'Hours.'), I('End Time', 'tk_t2'),
I('Fluid Weight', 'tw_ppg', '{{8.34|densityLiquid}}'), I('Fluid Volume', 'tw_gal'), I('Tare Weight', 'tw_tare'), I('Tank Footprint', 'tw_area')],
outputs: [O('Strapping Factor', 'Volume per unit of level.'), O('Rate', 'Per hour and per day.'), O('Deck Loading', 'Weight per unit area.')],
example: { title: 'A one-hour tank rate', setup: ['{{0|volume}} at {{0|time}}, {{5.2|volume}} at {{1|time}}.'], result: ['{{124.8|liquidRate|1}}.'],
check: P('calcTankRate', 0, { expectText: ['124.8 BPD'] }) },
tips: ['Leave at least 30 minutes between readings.'], refs: [{ std: 'API MPMS Ch. 2', note: 'tank calibration' }], related: ['sep', 'sepqc', 'proving'],
shots: V('Tank Calculator', ['#tr_h']) });

g.pumpsz = A(S('pumpsz', 'c1d0e8cd', ['transfer pump', 'NPSH']), {
purpose: 'Sizes a transfer pump: total dynamic head, power, NPSH available and pump type for a liquid line.',
what: ['Head is the pressure rise, lift and friction (+30 % fittings), +6 %. NPSHa compares the suction and vapour pressures.', 'Heads and lengths are in metres on both unit settings.'],
when: ['Choosing a transfer pump.', 'Checking that a pump will not cavitate.'],
steps: [F('Pump Sizing'), 'Fill **Process Conditions** ① and **System**.', 'Enter the **Pump Efficiency** and **Vapour Pressure**.', CALC + 'the head, power, NPSHa and pump type.'],
inputs: [I('Flow Rate', 'ps_q', '{{5000|liquidRate}}'), I('Liquid Type', 'ps_liq'), I('API Gravity', 'ps_api', 0, 'Crude oil only.'), I('Viscosity', 'ps_mu', '{{5|viscosity}}'),
I('Temperature', 'ps_t', 0, NU), I('Suction Pressure', 'ps_ps', '{{50|pressureG}}'), I('Discharge Pressure', 'ps_pd', '{{300|pressureG}}'),
I('Static Head - Suction', 'ps_hs'), I('Static Head - Discharge', 'ps_hd'), I('Suction Pipe Length', 'ps_ls'), I('Discharge Pipe Length', 'ps_ld'), I('Pipe Size', 'ps_pipe'),
I('Pump Efficiency', 'ps_eff'), I('Vapour Pressure', 'ps_vp', '{{2|pressure}}', 'Absolute.')],
outputs: [O('Total Dynamic Head', 'In metres.'), O('NPSHa', 'Suction head available.'), O('Pump Type', 'By viscosity.')],
example: { title: DEF, setup: ['{{5000|liquidRate}}, {{50|pressureG}} to {{300|pressureG}}.'], result: ['238.3 m, 28.09 kW, NPSHa 52.27 m: Centrifugal.'],
check: P('calcPumpSz', 0, { expectText: ['238.3 m', '28.09 kW', '52.27 m', 'Centrifugal'] }) },
pitfalls: ['Live crude is near its bubble point.'], refs: [P610], related: ['arc', 'tank', 'elec'],
shots: V('Pump Sizing', ['#ps_q']) });

g.arc = A(S('arc', 'eb6b7d34', ['recirculation', 'minimum flow']), {
purpose: 'Sizes an automatic recirculation (ARC) valve that keeps a centrifugal pump above its minimum flow.',
what: ['Discharge at the minimum flow is taken 60 % of the way from normal to shut-off. The bypass ΔP sets the severity; the flow sets the size.'],
when: ['A centrifugal pump can run throttled.', 'Choosing a bypass valve.'],
steps: [F('ARC Valve Sizing'), 'Enter the **Normal Process Flow** ① and **Min Process Flow**.', 'Enter the pump curve pressures ② and the **Bypass Return Pressure**.', CALC + 'the ΔP, severity and valve.'],
inputs: [I('Normal Process Flow', 'av_qn', '{{5000|liquidRate}}'), I('Min Process Flow', 'av_qmin', '{{500|liquidRate}}'), I('API Gravity', 'av_api'),
I('Pump Discharge @ Shutoff', 'av_pso', '{{500|pressureG}}'), I('Pump Discharge @ Normal', 'av_pdn', '{{350|pressureG}}'), I('Bypass Return Pressure', 'av_ret', '{{50|pressureG}}')],
outputs: [O('Protection Severity', 'Normal to {{80|pressure}}, Medium to {{150|pressure}}, then High: use a multi-stage bypass.')],
example: { title: DEF, setup: ['{{500|liquidRate}} minimum, return {{50|pressureG}}.'], result: ['ΔP {{390|pressure}}: High, valve “1.5"”.'],
check: P('calcARC', 0, { expectText: ['390 psi', 'High', '1.5"'] }) },
pitfalls: ['Take the minimum flow from the pump data sheet.'], refs: [P610], related: ['pumpsz', 'tank'],
shots: V('ARC Valve Sizing', ['#av_qn', '#av_pso']) });

g.aircomp = A(S('aircomp', 'a7200309', ['instrument air', 'receiver']), {
purpose: 'Picks an air compressor capacity and type, and a receiver volume, for instrument or utility air.',
what: ['Capacity is the demand + 10 %; the receiver 5 US gallons per SCFM. Rotary screw above {{30|airFlow}}, or continuous instrument air above {{15|airFlow}}.'],
when: ['Planning air for controllers and ESD pilots.', 'Checking a rental compressor.'],
steps: [F('Air Compressor'), 'Enter the total **Air Flow** ① and the **Required Pressure**.', 'Choose the **Duty Pattern** ② and the other options.', CALC + 'the capacity, receiver and type.'],
inputs: [I('Air Flow', 'ac_q', '{{150|airFlow}}'), I('Required Pressure', 'ac_p', 0, 'Not used in the sizing.'), I('Duty Pattern', 'ac_duty'), I('Application', 'ac_app'), I('Oil-Free Required?', 'ac_of')],
outputs: [O('Selected Capacity', 'Demand + 10 %.'), O('Compressor Type', 'Rotary Screw or Reciprocating.')],
example: { title: DEF, setup: ['{{150|airFlow}} instrument air.'], result: ['{{165|airFlow}}, 825 gal, Rotary Screw.'], check: P('calcAirComp', 0, { expectText: ['165 SCFM', '825 gal'] }) },
tips: ['Instrument air must be dry.'], refs: [{ std: 'ISO 8573-1', note: 'air purity' }], related: ['esdhi', 'gensz'],
shots: V('Air Compressor', ['#ac_q', '#ac_duty']) });

return { guides: g };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
