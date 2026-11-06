// prism-build/48-calc-help-metering.js — Help content: Metering & Chokes (docs/HELP-GUIDE-PLAN.md §4, WP-C2).
// Data only (no WTS_calcRegistry page); the factory runs on the first Help open. Rows: input 'label~id~cat~default~text' (cat: key of K),
// verdict 'mark~match~text', call-out 'selector~n'.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'metering', routes: ['aga3', 'orifice', 'choke', 'chokeflow', 'chokecnv', 'chokeperf', 'mcfshr', 'turbmeter', 'proving', 'sepqc'], build: function () {
var K = { p: 'pressureG', P: 'pressure', b: 'pressureBase', d: 'pressureSmall60', t: 'temperature', L: 'lengthSmall', q: 'gasRateSmall', Q: 'liquidRate',
v: 'volume', '%': 'percent', s: 'sg', a: 'api', g: 'gor', n: 'count', x: 'dimensionless', u: 'viscosity', m: 'timeMin' };
function sp(s) { return s.split('~'); }
function I(s) { var a = sp(s), c = K[a[2]], o = { label: a[0], id: a[1] }; if (c) o.cat = c; if (a[3]) o.def = c ? '{{' + a[3] + '|' + c + '}}' : a[3]; if (a[4]) o.text = a[4]; return o; }
function O(s) { var a = sp(s); return { label: a[0], text: a[1] }; }
function V(s) { var a = sp(s); return { mark: a[0], match: a[1], text: a[2] }; }
function C(s) { var a = sp(s); return { sel: a[0], n: +a[1] }; }
function Sh(id, view, alt, cap, co, x) { var o = { id: id, view: view, alt: alt, caption: cap || 'The page as it opens', callouts: co.map(C) }; return Object.assign(o, x); }
function Gd(r, src, g) {
  g.route = r; g.reviewed = 'v3.3.2'; g.reviewedSrc = src; g.units = g.units || 'dual';
  ['inputs', 'outputs', 'verdicts'].forEach(function (k, i) { if (g[k]) g[k] = g[k].map([I, O, V][i]); });
  g.steps = g.steps.map(function (x) { return typeof x === 'string' ? { t: x } : x; });
  if (g.verdictCases) g.verdictCases = g.verdictCases.map(function (x) { return { set: x }; });
  return g;
}
var HUB = 'Select **Chokes** in **Metering & Chokes**, then ', MC = ' in **Metering & Chokes**.', DEF = 'The default inputs', RES = 'Results for the default inputs';
var CALC = { click: '#pgBody .btn-primary' }, BTN = '#pgBody .btn-primary';
function W(r) { return [CALC, { waitFor: '#' + r + ' .rbox' }]; }
return { guides: {
aga3: Gd('aga3', 'e1042f88', {
notDocumented: [{ id: 'a_ps_go', why: 'step 6' }],
purpose: 'Gas rate through an orifice meter from the differential, static pressure and temperature (AGA Report No. 3).',
what: ['Cd, Y1 and Z, then the rate at your base conditions. To choose a plate, use [[orifice]].'],
when: ['Each orifice reading.', 'Checking a flow computer.'],
steps: [{ t: 'Select **AGA-3 Gas Metering**' + MC, shot: 'view' }, 'Enter the **Pipe Internal Dia** ① and the **Orifice Diameter** of the plate in use.',
'Enter the **Diff Pressure** ②, **Static Pressure** and **Flowing Temp**.', 'Enter the gas gravity and the CO2, H2S and N2 content.',
{ t: 'Select **Calculate Gas Rate**. Read the rate in Flow Results ③.', shot: 'res' }, 'To send the rate to PRiSM, enter the step start, then select **Append rate step to PRiSM**.'],
inputs: ['Pipe Internal Dia~a_pD~L~4.026~Measured bore.', 'Orifice Diameter~a_oD~L~2.0', 'Tap Type~a_tap~~Flange Taps', 'Diff Pressure~a_dP~d~50',
'Static Pressure~a_Ps~p~500~At the upstream tap.', 'Flowing Temp~a_Tf~t~80', 'Gas Specific Gravity~a_SG~s~0.65~Air = 1.', 'Gas gravity basis~a_sgb~~Real',
'CO2~a_CO2~%~0.5', 'H2S~a_H2S~%~0', 'N2~a_N2~%~1.0', 'Z-factor override~a_Z~~~Blank: built-in DAK Z.',
'Use calculated Z~a_usez~~~Z from Gas PVT.', 'Base Temp~a_Tb~t~60', 'Base Pressure~a_Pb~b~14.696',
'Step start, hours on the PRiSM data clock~a_ps_t'],
outputs: ['Flow Results~Gas rate at the base conditions.', 'Intermediate Values~β, Cd, Y1, Z, Fpv, Reynolds number.'],
example: { title: DEF, setup: ['{{2|lengthSmall}} plate in a {{4.026|lengthSmall}} run, {{50|pressureSmall60}}, {{500|pressureG}}, {{80|temperature}}.'],
result: ['{{4122.5|gasRateSmall|1}}; β 0.4968, Cd 0.6031, Y1 0.99884, Z 0.9153.'],
check: { kind: 'compute', fn: 'WTS_aga3_compute', tol: 0.001, input: { D: 4.026, d: 2, hw: 50, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, h2s: 0, n2: 1, TbF: 60, Pb: 14.696, tap: 'flange' },
expect: { Qmscfd: 4122.54, beta: 0.49677, Cd: 0.6031, Y1: 0.99884, Z: 0.91533 } } },
pitfalls: ['A typed Z stays in use until you clear it. The Notes then show a ⚠.'],
refs: [{ std: 'AGA Report No. 3 / API MPMS Ch. 14.3', note: 'orifice flow equation' }],
related: ['orifice', 'gaspvt', 'sepqc'],
shots: [Sh('view', 'both', 'AGA-3 page, default inputs', '', ['#a_pD~1', '#a_dP~2']),
Sh('res', 'desktop', 'Flow Results and Intermediate Values', RES, ['#a_res .rbox:nth-child(1)~3'], { target: '#a_res', setup: W('a_res') })]
}),
orifice: Gd('orifice', '778aed14', {
notDocumented: [{ id: 'op_calc', why: 'Select Plate, step 5' }],
purpose: 'Picks the orifice bore that keeps the differential inside your window of the transmitter range at a target gas rate.',
what: ['The page runs the [[aga3]] calculation backwards. It finds the exact bore for your design differential, then the nearest 0.125" plate that stays inside your low and high limits.'],
when: ['Before a test: choose the plate for the expected gas rate.', 'During a test: the differential nears the top or bottom of the range.'],
steps: [{ t: 'Select **Orifice Plate Selection**' + MC, shot: 'view' }, 'Enter the **Target gas rate** ① and the meter run, line and gas data.',
'Enter the **Transmitter range, 0 to** of your DP cell.', 'Set the window: **Low limit**, **High limit** and **Design differential**.',
'Select **Select Plate**. The page also updates on every change.', { t: 'Read the verdict, then the **Orifice bore** ②.', shot: 'res' },
{ t: 'Plan plate changes with the **Plate-Change Points** table ③.', shot: 'tbl' }],
inputs: ['Target gas rate~op_q~q~5000~At the base conditions.', 'Meter run internal diameter~op_D~L~4.026~Measured bore; at least {{2|lengthSmall}}.',
'Static (line) pressure~op_P~p~500', 'Flowing temperature~op_T~t~80', 'Gas specific gravity~op_SG~~0.65', 'Gas gravity basis~op_sgb~~Real',
'CO2~op_CO2~~0.5 %', 'N2~op_N2~~1.0 %~Not in the Z correction.', 'H2S~op_H2S~~0 %', 'Transmitter range, 0 to~op_urv~d~200~DP cell upper range value.',
'Low limit~op_lo~~20 %', 'High limit~op_hi~~80 %', 'Design differential~op_des~~50 %~Where the target rate should sit.',
'Base temperature~op_Tb~t~60~Follows the header Std setting.', 'Base pressure, absolute~op_Pb~b~14.696'],
outputs: ['Orifice bore, Beta ratio~The plate to fit and d/D (AGA-3: 0.10 to 0.75).',
'Exact Bore and Neighbours~Next plates up and down.'],
verdicts: ['✓~of range at the target rate — inside~The plate reads inside the window. Fit it; confirm the bore on site.',
'✗~plate lands inside~No 0.125" plate fits the window. Widen it or change the range.', '✗~keeps the differential below~Too much gas: use a larger run or a higher range.',
'✗~lifts the differential above~Too little gas: use a smaller run or a lower range.', '⚠~at the target rate — above 0.2~x1 above 0.2: Y1 is outside its validated range.',
'⚠~x1 exceeds 0.2~Line pressure is low for this range.', '⚠~below the AGA-3 minimum~Run below {{2|lengthSmall}}: an estimate only.',
'⚠~straight lengths~β above 0.6: check the upstream straight lengths.'],
verdictCases: [{ op_q: '50000' }, { op_lo: '49', op_hi: '51' }, { op_q: '20' }, { op_P: '50' }, { op_P: '20', op_urv: '400', op_q: '1500' }, { op_P: '10', op_urv: '400' }, { op_D: '1.5', op_q: '500' }],
example: { title: DEF, setup: ['{{5000|gasRateSmall}}, {{4.026|lengthSmall}} run, {{500|pressureG}}, {{80|temperature}}, gravity 0.65, cell 0 to {{200|pressureSmall60}}.'],
result: ['✓ {{1.875|lengthSmall|3}} plate, β 0.466, {{97.2|pressureSmall60|1}} = 48.6 % of range.', 'Change down below {{3214|gasRateSmall}}, up above {{6406|gasRateSmall}}.'],
check: { kind: 'compute', fn: 'WTS_orifice_compute', tol: 0.001, input: { q: 5000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, n2: 1, h2s: 0, urv: 200 },
expect: { inWindow: true, 'chosen.d': 1.875, 'chosen.beta': 0.4657, 'chosen.hw': 97.16, 'chosen.pct': 48.58, 'chosen.qLo': 3213.6, 'chosen.qHi': 6405.7 } } },
tips: ['Keep the next plate up and down at the meter.'],
pitfalls: ['Enter the measured tube bore ({{4.026|lengthSmall}}), not the nominal size.'],
refs: [{ std: 'AGA Report No. 3 / API MPMS Ch. 14.3', note: 'β limits' }, { std: 'ISO 5167-1 and -2', note: 'DP range' }],
related: ['aga3', 'proving', 'sepqc'],
shots: [Sh('view', 'both', 'Orifice Plate Selection, default inputs', '', ['#op_q~1']),
Sh('res', 'desktop', 'Selected Plate box', RES, ['#op_res .rbox:nth-child(2) .rrow:nth-child(2)~2'], { target: '#op_res .rbox:nth-child(2)' }),
Sh('tbl', 'desktop', 'Plate-change table', 'Plate-change points', ['#op_res table.dtable~3'], { target: '#op_res table.dtable' })]
}),
choke: Gd('choke', '1fb5df3c', {
purpose: 'Two chokes in series: intermediate pressure, drop on each, critical checks, equivalent bean and rate.',
what: ['Gas: the API 14B equation on both beans. Multiphase: Gilbert through the equivalent bean.'],
when: ['A fixed and an adjustable choke in series.', 'Which choke takes the drop.'],
steps: [{ t: HUB + '**Dual Choke**.', shot: 'view' }, 'Enter the **Upstream Pressure** ① and **Downstream Pressure** ②.', 'Choose the **Fluid Type**.',
'Enter each choke size in 64ths and its Cd.', 'For multiphase, also enter the oil gravity, **GOR** and **Water Cut**.',
{ t: 'Select **Calculate**. Read P2 ③, the drop on each choke and the critical checks.', shot: 'res' }],
inputs: ['Upstream Pressure~c_P1~p~1500', 'Downstream Pressure~c_P3~p~500', 'Fluid Type~c_ft~~Gas Only', 'Flowing Temp~c_T~t~150',
'Choke 1 Size~c_s1~n~32~Upstream choke, 64ths.', 'Choke 1 Cd~c_cd1~x~0.85', 'Choke 2 Size~c_s2~n~24', 'Choke 2 Cd~c_cd2~x~0.85',
'Gas Specific Gravity~c_SG~s~0.65', 'Oil Gravity~c_API~a~35~Multiphase.', 'GOR~c_GOR~g~800~Multiphase.', 'Water Cut~c_WC~%~10~Multiphase.'],
outputs: ['Intermediate Pressure (P2)~Between the chokes.',
'Flow Estimate~Gas rate, or Gilbert rates.'],
example: { title: DEF + ' (gas)', setup: ['{{1500|pressureG}} to {{500|pressureG}}, 32/64 then 24/64.'],
result: ['P2 {{1400.7|pressureG|1}}; the 24/64 choke takes 90 % and flows critical.', 'Equivalent bean 22.4/64; {{4146.7|gasRateSmall|1}}.'],
check: { kind: 'page', calc: 'calcChoke', set: {}, expectText: ['Intermediate Pressure (P2)1,400.7 psig', 'Equivalent Choke Size22.4/64', 'Gas Rate4,146.7 MSCF/D'] } },
pitfalls: ['Pressures are gauge. The multiphase rate assumes critical flow.'],
refs: [{ std: 'API 14B', note: 'gas choke equation' }, { std: 'Gilbert (1954)', note: 'bean correlation' }],
related: ['chokeperf', 'chokeflow', 'chokecnv'],
shots: [Sh('view', 'both', 'Dual Choke page, default inputs', '', ['#c_P1~1', '#c_P3~2']),
Sh('res', 'desktop', 'Choke Results and Flow Estimate', RES, ['#c_res .rbox:nth-child(1) .rrow:nth-child(2)~3'], { target: '#c_res', setup: W('c_res') })]
}),
chokeflow: Gd('chokeflow', 'a47f381f', {
purpose: 'Quick gas rate through a fixed choke, and oil rate by the Gilbert and Ros equations.',
what: ['Gas: coefficient × absolute WHP ÷ √(gravity × absolute temperature), for critical flow of dry gas.'],
when: ['A first rate estimate.', 'Cross-checking a meter.'],
steps: [{ t: HUB + '**Choke Flow Rates**.', shot: 'view' }, 'For gas, enter the **Choke Size** ①, **Wellhead Pressure**, **Wellhead Temp** and **Gas Gravity**.',
'Select **Calculate Gas Rate** ②.', 'For oil, enter the **Upstream Pressure**, bean and **GOR**, then select **Calculate Oil Rate**.',
'Look up a size in the **Choke Coefficient Reference** table.'],
inputs: ['Choke Size~cf_cs~n~32~Gas, 2 to 128.', 'Wellhead Pressure~cf_whp~p~3000', 'Wellhead Temp~cf_wht~t~120', 'Gas Gravity~cf_sg~s~0.7',
'Upstream Pressure~cf_op~p~1500', 'Choke Size~cf_ocs~n~32~Oil.', 'GOR~cf_gor~g~500~Used as the gas–liquid ratio.'],
outputs: ['Gas Rate Result~Coefficient and gas rate.', 'Oil Rate Results~Gilbert and Ros rates.'],
example: { title: 'Gas, 32/64', setup: ['{{3000|pressureG}}, {{120|temperature}}, gravity 0.7.'], result: ['Coefficient 112.72; {{16864.8|gasRateSmall|1}}.'],
check: { kind: 'page', calc: 'calcChokeGas', set: {}, expectText: ['Choke Coefficient112.72', 'Gas Rate16,864.8 MSCF/D'] } },
pitfalls: ['The oil rates are gross liquid, for critical flow only.'],
refs: [{ std: 'Gilbert (1954), Ros (1960)', note: 'bean correlations' }],
related: ['chokeperf', 'choke'],
shots: [Sh('view', 'both', 'Choke Flow Rates page', '', ['#cf_cs~1', BTN + '~2'])]
}),
chokecnv: Gd('chokecnv', 'b0672f6c', {
units: 'none',
purpose: 'Converts a choke size between 64ths of an inch, decimal inches and millimetres.',
what: ['Type in one box; the others fill in. Not affected by the Metric setting.'],
when: ['A bean stamped in mm.', 'A page asks for 64ths.'],
steps: [{ t: HUB + '**Choke Conversions**.', shot: 'view' }, 'Type the size in **Size**, **Decimal Inches** or **Millimeters** ①.',
'Read the other boxes. Clearing one clears all three.', 'The **Common Sizes** table lists the usual beans ②.'],
inputs: ['Size~cc_64~~~In 64ths.', 'Decimal Inches~cc_in', 'Millimeters~cc_mm'],
outputs: ['Common Sizes~8/64 to 64/64.'],
example: { title: 'A 32/64 bean', setup: ['Type 32 in Size.'], result: ['0.5000 in, 12.70 mm.'], check: { kind: 'page', set: { cc_64: '32' }, expectText: ['32/640.500012.70'] } },
tips: ['A worn bean flows like a larger one: tune it on [[chokeperf]].'],
noRefs: 'A unit conversion.',
related: ['chokeperf'],
shots: [Sh('view', 'both', 'Choke Size Conversions page', '', ['#cc_64~1', '#pgBody .dtable~2'])]
}),
chokeperf: Gd('chokeperf', '1ba7c679', {
notDocumented: [{ id: 'ck_calc', why: 'Calculate' }],
purpose: 'Critical-flow check, gas and multiphase rate through a bean, and a bean-up plan.',
what: ['Gas: nozzle equation, k and Z from [[gaspvt]]. Oil wells: four correlations. The shut-in WHP gives the next beans.'],
when: ['Planning the next bean change.', 'Checking the bean flows critical.'],
steps: [{ t: HUB + '**Choke Performance**.', shot: 'view' }, 'Choose **Flow through the bean** ①.', 'Enter the **Bean size** ② and both pressures.',
'Gas: enter temperature and gravity. Oil well: gas–liquid ratio and water cut.',
'For bean-up, enter the **Shut-in wellhead pressure** and any measured rate.', { t: 'The page updates on every change. Read the **Checks** ③.', shot: 'res' }],
inputs: ['Flow through the bean~ck_fluid~~Dry gas', 'Bean size~ck_size~~24', 'Bean size in~ck_sunit~~64ths of an inch', 'Upstream pressure, WHP~ck_p1~p~1500',
'Downstream pressure~ck_p2~p~400~Optional for an oil well.', 'Discharge coefficient Cd~ck_cd~~0.85', 'Bean correlation~ck_corr~~Gilbert (1954)~For bean-up.',
'Upstream temperature~ck_t~t~120', 'Gas gravity~ck_sg~s~0.7', 'CO2~ck_co2~%~0', 'H2S~ck_h2s~%~0', 'N2~ck_n2~%~0', 'Cp/Cv k~ck_k~~~Blank: Gas PVT.',
'Z at upstream~ck_z~~~Blank: Gas PVT.', 'Gas–liquid ratio~ck_glr~g~800', 'Water cut~ck_wc~%~0', 'Shut-in wellhead pressure~ck_pws~p~2500~Blank holds the WHP.',
'Measured gas rate now, optional~ck_qmg~q~~Tunes the equation.', 'Measured liquid rate now, optional~ck_qml~Q', 'Back-pressure exponent n~ck_n~~1'],
outputs: ['Gas Flow Through the Bean~k, Z, regime, rate.', 'Bean-up Planning~The next four beans.'],
verdicts: ['✓~Critical (sonic) flow~Downstream pressure does not change the rate.', '⚠~Subcritical flow~The rate depends on the downstream pressure.',
'✓~Critical flow: p2/p1~The correlations apply.', '⚠~Not critical~The correlations read high.', '⚠~Downstream pressure not given~Critical flow assumed.',
'⚠~Measured rate is~Over 30 % off: check bean, Cd, wear, liquid loading.', '⚠~Shut-in WHP not given~Bean-up rates read high.',
'⚠~largest standard size~No bean-up rows.', '⚠~Some bean-up rows~Those rows are less certain.'],
verdictCases: [{ ck_p2: '1000' }, { ck_p2: '800' }, { ck_fluid: 'liquid' }, { ck_fluid: 'liquid', ck_p2: '' }, { ck_fluid: 'liquid', ck_p2: '1000' }, { ck_qmg: '9000' }, { ck_pws: '' }, { ck_size: '128' }],
example: { title: DEF + ' (gas)', setup: ['24/64, {{1500|pressureG}} to {{400|pressureG}}, shut-in {{2500|pressureG}}.'],
result: ['✓ Critical, p2/p1 0.274 below 0.556; {{4496|gasRateSmall}}.', '26/64: {{4860|gasRateSmall}} at {{1388|pressureG}}.'],
check: { kind: 'compute', fn: 'WTS_chokeperf_compute', tol: 0.001, input: { fluid: 'gas', s64: 24, p1: 1500, p2: 400, t: 120, sg: 0.7, cd: 0.85, pws: 2500, n: 1 },
expect: { critical: true, q: 4496.26, rc: 0.55637, 'beanUp.0.q': 4860.44, 'beanUp.0.pwh': 1388.13 } } },
tips: ['Step up one bean at a time and re-test.'],
refs: [{ std: 'Gilbert, Ros, Baxendell, Achong', note: 'bean correlations' }],
related: ['choke', 'gaspvt', 'wts'],
shots: [Sh('view', 'both', 'Choke Performance page, default inputs', '', ['#ck_fluid~1', '#ck_size~2']),
Sh('res', 'desktop', 'Checks box', 'Checks for the defaults', ['#ck_res .rbox:nth-child(3) > div:nth-child(2)~3'], { target: '#ck_res .rbox:nth-child(3)' })]
}),
mcfshr: Gd('mcfshr', 'f4d101d2', {
purpose: 'Meter correction factor and shrinkage from turbine meter readings and surge tank levels.',
what: ['MCF = tank volume moved ÷ metered volume. Levels are tank volumes.'],
when: ['Oil meter against the tank.', 'Shrinkage in the tank.'],
steps: [{ t: 'Select **MCF & Shrinkage %**' + MC, shot: 'view' }, 'At the start, enter **Turbine Meter Initial** ① and **Surge Tank Initial Level**.',
'At the end, enter **Turbine Meter Final** and **Surge Tank Final Level**.', 'When the tank settles, enter **Surge Tank Stabilized Level** ②.', 'Select **Calculate** ③.'],
inputs: ['Turbine Meter Initial~ms_ti~v~1000', 'Turbine Meter Final~ms_tf~v~1010', 'Surge Tank Initial Level~ms_si~v~50', 'Surge Tank Final Level~ms_sf~v~60',
'Surge Tank Stabilized Level~ms_ss~v~58.5~Between initial and final.'],
outputs: ['MCF~Tank volume ÷ metered volume.', 'Shrinkage %~Lost as the tank settles.'],
example: { title: 'The meter reads low', setup: ['Meter {{1000|volume}} to {{1009.5|volume}}; tank {{50|volume}} to {{60|volume}}, settles at {{58.5|volume}}.'],
result: ['MCF 1.052632; shrinkage 15 %.'], check: { kind: 'page', calc: 'calcMCFShr', set: { ms_tf: '1009.5' }, expectText: ['MCF1.052632', 'Shrinkage %15 %'] } },
tips: ['Use the same period for the meter and the tank.'],
noRefs: 'The definitions on the page. For a formal meter factor, use [[proving]].',
related: ['proving', 'turbmeter'],
shots: [Sh('view', 'both', 'MCF and Shrinkage page', '', ['#ms_ti~1', '#ms_ss~2', BTN + '~3'])]
}),
turbmeter: Gd('turbmeter', 'b0cb08bb', {
purpose: 'Sizes a liquid turbine meter and checks viscosity, Reynolds number and cavitation margin.',
what: ['The smallest meter that covers Qmax; a note when Qmin is below its range.'],
when: ['Choosing a liquid meter.', 'Low rates read badly.'],
steps: [{ t: 'Select **Turbine Meter**' + MC, shot: 'view' }, 'Choose the **Liquid Type** ①; enter gravity, temperature and viscosity.',
'Enter **Qmin** ②, **Qmax** and the **Operating Pressure**.', 'For live crude, enter the **True Vapour Pressure, abs**.', { t: 'Select **Calculate**. Read Re and the cavitation margin ③.', shot: 'res' }],
inputs: ['Liquid Type~tm_liq~~Crude Oil', 'API Gravity~tm_api~a~35', 'Temperature~tm_t~~40~In °C here.', 'Viscosity~tm_mu~u~5~Above {{30|viscosity}}: not suitable.',
'Qmin~tm_qmin~Q~500', 'Qmax~tm_qmax~Q~8000', 'Operating Pressure~tm_p~p~500', 'True Vapour Pressure, abs~tm_pv~P~~Blank: a default per liquid.'],
outputs: ['Re @ Qmin~LOW below 10,000.', 'Cavitation Margin~LOW below {{3|pressure}}.'],
example: { title: DEF, setup: ['Crude, {{500|liquidRate}} to {{8000|liquidRate}} at {{500|pressureG}}.'], result: ['3-inch meter; Re 2,511 LOW; margin {{514.4|pressure|1}} OK.'],
check: { kind: 'page', calc: 'calcTurbMeter', set: {}, expectText: ['Selected Meter: 3"', 'Re @ Qmin2,511 LOW', 'Cavitation Margin514.4 psi OK'] } },
pitfalls: ['Separator crude is at its bubble point: enter the separator pressure (absolute) as vapour pressure.'],
refs: [{ std: 'API MPMS Ch. 5.3', note: 'turbine meters' }],
related: ['proving', 'mcfshr'],
shots: [Sh('view', 'both', 'Turbine Meter page, default inputs', '', ['#tm_liq~1', '#tm_qmin~2']),
Sh('res', 'desktop', 'Selected meter box', RES, ['#tm_res .rbox .rrow:nth-child(5)~3'], { target: '#tm_res .rbox', setup: W('tm_res').concat({ scroll: '#tm_res' }) })]
}),
proving: Gd('proving', 'fb01f394', {
notDocumented: [{ pattern: '^pv_(iv|tp|pp|tm|pm)\\d+$', why: 'Prover Runs cells (step 3)' }, { id: 'pv_calc', why: 'Calculate' }],
purpose: 'Meter factor from prover runs, repeatability, CTL and CPL, and the net standard volume ticket.',
what: ['Average data method, MPMS 4.8 repeatability, the ticket, and the [[oilgas]] chain factor by factor.'],
when: ['Proving the oil meter.', 'Checking a ticket.'],
steps: [{ t: 'Select **Meter Proving & NSV**' + MC, shot: 'view' }, 'In **Liquid and Prover**, set the **Commodity group** ①, **Observed gravity** ② and prover data.',
'In **Prover Runs**, enter one row per run.', 'In **Measurement Ticket**, enter the readings, temperature, pressure and S&W.',
'For the audit trail, select **Copy from Oil & Gas Rate**.', { t: 'Read the ✓ ✗ lines in each box ③.', shot: 'res' }],
inputs: ['Commodity group~pv_grp~~Crude oil (Table 6A)', 'Observed gravity~pv_api~a~32.5', 'Hydrometer temperature~pv_th~t~75', 'Equilibrium vapour pressure~pv_pe~p~0',
'Prover base volume~pv_bpv~v~50', 'Prover steel~pv_steel~~Carbon steel', 'Prover inside diameter~pv_pid~L~15.25', 'Prover wall thickness~pv_wall~L~0.375',
'Previous meter factor~pv_prev~~1.0005~Blank: no change check.', 'Meter-factor change limit~pv_mft~%~0.25', 'Round per API MPMS 12.2~pv_round~~On',
'Opening meter reading~pv_to~v~125000', 'Closing meter reading~pv_tc~v~131250.4', 'Average meter temperature~pv_ttm~t~78', 'Average meter pressure~pv_tpm~p~100',
'S&W~pv_tsw~%~0.35', 'Meter factor~pv_tmf~~~Blank: proven.', 'Calc interval~pv_aint~m~60', 'API gravity~pv_aapi~a~35', 'Hydrometer temperature~pv_aht~t~80',
'Previous meter~pv_am0~v~1000', 'Current meter~pv_am1~v~1004.5', 'Oil line temperature~pv_at~t~120', 'BS&W~pv_absw~%~2', 'Meter factor~pv_amf~~1.0',
'Shrinkage factor~pv_ashr~~0.95', 'Oil line pressure for CPL~pv_ap~p', 'Gas rate for GOR~pv_agas~q', 'Copy from Oil & Gas Rate~pv_copy'],
outputs: ['Meter Proving~Meter factor, repeatability.', 'Net Standard Volume~IV to NSV.'],
verdicts: ['✓~is within the~Repeatability inside the MPMS 4.8 limit.', '✗~exceeds the~Do more runs or find the cause.', '✓~Meter factor changed~Within the change limit.',
'⚠~Meter factor changed~Beyond the limit: check the meter.', '✓~rounded to the API MPMS 12.2~Rounded per MPMS 12.2.', '⚠~rounding is off~Unrounded values.',
'✓~Same chain and factors~The Oil & Gas Rate chain.', '✗~At least three prover runs~Too few runs.', '✗~No meter factor~Prove the meter or type a factor.',
'⚠~is outside the~Density does not fit the group.'],
verdictCases: [{ pv_iv2: '49.99', pv_prev: '1.003', pv_round: false }, { pv_iv3: '', pv_iv4: '', pv_iv5: '', pv_amf: '' }, { pv_prev: '1.01' }, { pv_grp: 'gasoline' }],
example: { title: 'The default five runs', setup: ['Crude, {{50|volume}} prover, runs near {{78|temperature}}.'],
result: ['MF 1.0012; repeatability 0.0400 % ✓.', 'NSV {{6188.04|volume|2}}; audit rate {{97.72|liquidRate|2}}.'],
check: { kind: 'page', set: {}, tol: 0.001, expectState: { 'proving.mf': 1.0012, 'proving.rangePct': 0.04, 'proving.nsv': 6188.04, 'proving.auditRate': 97.723 } } },
pitfalls: ['IVm is pulses ÷ nominal K-factor, not a corrected volume.'],
refs: [{ std: 'API MPMS Ch. 4.8, 11.1, 12.2', note: 'proving, CTL/CPL, ticket' }],
related: ['oilgas', 'mcfshr'],
shots: [Sh('view', 'both', 'Meter Proving page', '', ['#pv_grp~1', '#pv_api~2']),
Sh('res', 'desktop', 'Net Standard Volume ticket', 'The ticket for the defaults', ['#pv_res .rbox:nth-child(3) > div:last-child~3'], { target: '#pv_res .rbox:nth-child(3)' })]
}),
sepqc: Gd('sepqc', '1b3a3c07', {
notDocumented: [{ pattern: '^sq_b(id|k|po|to|ps|sg)\\d+$', why: 'Sample Bottles cells (step 5)' }, { id: 'sq_calc', why: 'Calculate' }],
purpose: 'Corrects the gas rate and GOR for the laboratory and checks the sample bottles (API RP 44).',
what: ['Laboratory gravity and Z, shrinkage, GOR on both bases, then each bottle and the duplicates.'],
when: ['Before samples go to the laboratory.', 'Laboratory gravity differs from the meter.'],
steps: [{ t: 'Select **Sampling & GOR QC**' + MC, shot: 'view' }, 'In **Separator and Rates**, enter the **Separator pressure** ①, conditions, rates and **Oil rate basis**.',
'In **Gas Gravity and Z**, enter the meter and laboratory gravities.', 'Choose the **Shrinkage source** and tolerances.', 'In **Sample Bottles**, enter one row per bottle.',
{ t: 'Read the recombination GOR ②, then the bottle checks.', shot: 'res' }],
inputs: ['Separator pressure~sq_psep~p~500', 'Separator temperature~sq_tsep~t~100', 'Stock-tank oil gravity~sq_api~a~40', 'Field gas rate~sq_qg~q~5000',
'Oil rate~sq_qo~Q~2000', 'Oil rate basis~sq_basis~~Separator conditions (metered)', 'Field gas gravity used by the meter~sq_sgf~s~0.70',
'Laboratory gas gravity~sq_sgl~s~~Blank: mean of gas bottles.', 'Laboratory CO2~sq_co2~%~2', 'Laboratory H2S~sq_h2s~%~0', 'Laboratory N2~sq_n2~%~0.5',
'Field Z-factor~sq_zf~~~Blank: calculated.', 'Laboratory Z-factor~sq_zl', 'Shrinkage source~sq_shrm~~Standing Bo at separator conditions',
'Shrinkage factor, typed~sq_shr~~0.90', 'Opening-pressure tolerance~sq_tolo~%~5', 'Saturation-pressure tolerance~sq_tols~%~5', 'Duplicate-agreement tolerance~sq_told~%~2'],
outputs: ['Shrinkage and GOR~GOR on both bases.', 'Sample Validity~A ✓ ⚠ ✗ per bottle.'],
verdicts: ['✓~Recombine the separator gas~The GOR for the laboratory.', '✓~✓~A check or bottle passed.', '⚠~⚠~Verdict column: a warning.', '✗~✗~Verdict column: failed.',
'✗~below the expected value~Leak or lost gas.', '⚠~above the expected value~Check bottle temperature and filling.',
'⚠~not at separator temperature~Indicative only.', '✗~below separator pressure~Gas lost from the sample.',
'✗~above separator pressure~Free gas, or no equilibrium.', '⚠~no laboratory saturation~Not measured yet.', '⚠~only checked for oil~Not checked.',
'✗~differ by~Resample.', '⚠~Fewer than two~No duplicate pair.', '⚠~change the gas rate by~Report the corrected GOR.',
'✗~check(s) failed~Resample or reject flagged bottles.', '⚠~No check failed~Review the warnings.'],
verdictCases: [{ sq_sgf: '0.75' }, { sq_bpo1: '400', sq_bto1: '120' }, { sq_bps2: '520', sq_bps3: '470', sq_bsg3: '0.80', sq_bpo2: '560' }, { sq_bps1: '', sq_bsg4: '', sq_bps2: '400' }, { sq_bps1: '600' }],
example: { title: DEF, setup: ['{{500|pressureG}}, {{5000|gasRateSmall}}, {{2000|liquidRate}}, meter gravity 0.70.'],
result: ['Gas rate −3.09 % to {{4845.6|gasRateSmall|1}}; S 0.9350.', '“Recombine … at 2,422.8 scf/bbl of separator liquid”.'],
check: { kind: 'page', set: {}, tol: 0.0005, expectState: { 'sepqc.S': 0.93498, 'sepqc.qGasCorr': 4845.59, 'sepqc.gorSepCorr': 2422.8, 'sepqc.fails': 0, 'sepqc.warns': 1 } } },
pitfalls: ['A metered separator oil rate is not a stock-tank rate: check the **Oil rate basis**.'],
refs: [{ std: 'API RP 44', note: 'reservoir fluid sampling' }],
related: ['aga3', 'oilgas', 'solgor'],
shots: [Sh('view', 'both', 'Sampling and GOR QC page', '', ['#sq_psep~1']),
Sh('res', 'desktop', 'Recombination GOR box', 'The recombination GOR', ['#sq_res .rbox:nth-child(3) .rrow:nth-child(2)~2'], { target: '#sq_res .rbox:nth-child(3)' })]
})
} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
