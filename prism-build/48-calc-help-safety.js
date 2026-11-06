// prism-build/48-calc-help-safety.js — Help content: Test System Safety (docs/HELP-GUIDE-PLAN.md §4, WP-C6).
// Data only; the factory runs on the first Help open. Rows: input 'label~id~cat~def~text', output 'label~text', verdict 'mark~match~text'.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'safety', routes: ['esdhi', 'esdlo', 'hydrate', 'cheminj', 'liquidline', 'pipelife', 'h2sroe', 'wellkill', 'complfluids'], build: function () {
var K = { p: 'pressureG', P: 'pressure', t: 'temperature', D: 'tempDelta', V: 'volumeFt3', G: 'gasRate', Q: 'liquidRate', s: 'sg', '%': 'percent', L: 'length',
l: 'lengthSmall', d: 'densityLiquid', v: 'volume', n: 'count', W: 'windSpeed', S: 'sandLoading', C: 'concentration', y: 'volPerMass', b: 'volumeSmall', m: 'mass' };
function sp(s) { return s.split('~'); }
function I(s) { var a = sp(s), c = K[a[2]], o = { label: a[0], id: a[1] }; if (c) o.cat = c; if (a[3]) o.def = c ? '{{' + a[3] + '|' + c + '}}' : a[3]; if (a[4]) o.text = a[4]; return o; }
function O(s) { var a = sp(s); return { label: a[0], text: a[1] }; }
function V(s) { var a = sp(s); return { mark: a[0], match: a[1], text: a[2] }; }
function N(s) { var a = sp(s); return a[0].charAt(0) === '^' ? { pattern: a[0], why: a[1] } : { id: a[0], why: a[1] }; }
function C(s) { var a = sp(s); return { sel: a[0], n: +a[1] }; }
function Sh(id, view, alt, cap, co, x) { return Object.assign({ id: id, view: view, alt: alt, caption: cap || 'The page as it opens', callouts: co.map(C) }, x); }
function Gd(r, src, g) {
  g.route = r; g.reviewed = 'v3.3.2'; g.reviewedSrc = src; g.units = 'dual';
  ['inputs', 'outputs', 'verdicts', 'notDocumented'].forEach(function (k, i) { if (g[k]) g[k] = g[k].map([I, O, V, N][i]); });
  g.steps = g.steps.map(function (x) { return typeof x === 'string' ? { t: x } : x; });
  if (g.verdictCases) g.verdictCases = g.verdictCases.map(function (x) { return { set: x }; });
  return g;
}
var TS = ' in **Test System Safety**.', HUB = 'Select **ESD Pilots** in **Test System Safety**, then **', DEF = 'The default inputs', RES = 'Results for the default inputs',
MET = 'Metric mode shows the same values converted.', CALC = 'Select **Calculate** ', ST = 'Calculate, step ';
function CL(b, w) { return [{ click: b }, { waitFor: w }]; }
function T(q) { return { target: q, setup: [{ scroll: q }] }; }
function PG(st, x) { return Object.assign({ kind: 'page', tol: 0.002, expectState: st }, x); }
return { guides: {
esdhi: Gd('esdhi', '4b481de8', {
keywords: ['PSH', 'backflow'],
notDocumented: ['wts_esdhi_calc~' + ST + '6', 'wts_esdhi_reset~step 7'],
purpose: 'Checks that the hi-pilot (PSH) shuts the well in before backflow lifts the relief device of a trapped section.',
what: ['The gas held between the hi-pilot and the relief setting, divided by the backflow rate, is the time to relief. It must exceed the ESD response. Ideal gas: a screening check.'],
when: ['Setting a hi-pilot on the choke manifold, heater or separator inlet.', 'After a change of section, relief device or ESD system.'],
steps: [{ t: HUB + 'ESD Hi-Pilot**.', shot: 'view' }, 'Choose the **Pre-set Location** ①; every value stays editable.',
'Enter the **Gas Backflow Rate** and check the **Hi-Pilot Setting**, relief setting and **Section MAWP**.', 'Enter the **ESD Response Time**: pilot trip to valve closed.',
{ t: CALC + 'and read the verdict, the tables and the rationale.', shot: 'res' }, '**Reset to Preset** puts back the location values.'],
inputs: ['Pre-set Location~wts_esdhi_loc~~Direct Steam Heater Shell', 'Section Volume~wts_esdhi_volume~V~292', 'Section Gas Temp~wts_esdhi_temp~t~23',
'Gas Backflow Rate~wts_esdhi_q~G~39.28~Worst case.', 'Gas Specific Gravity~wts_esdhi_sg~s~0.78~Not used.', 'Hi-Pilot Setting~wts_esdhi_hp~p~112~At least 10 % below the MAWP.',
'Rupture Disc / RV Setting~wts_esdhi_rd~p~125~At or below the MAWP.', 'Section MAWP~wts_esdhi_mawp~p~125', 'ESD Response Time~wts_esdhi_tresp~~5 s'],
outputs: ['Computed Results~Time to relief, gas vented, margin.', 'Rationale~What would pass.'],
verdicts: ['✓~PASS — t_fill~The ESD closes before the relief setting is reached.', '✗~FAIL — Hi-pilot would NOT~The relief device lifts first.'],
example: { title: DEF, setup: ['Heater shell, {{292|volumeFt3}}, {{39.28|gasRate}}, hi-pilot {{112|pressureG}}, ESD 5 s.', MET],
result: ['✗ FAIL: relief in 0.61 s, {{2273|gasVolumeStd}} vented. A pass needs {{19|pressureG}} or less.'],
check: { kind: 'compute', fn: 'WTS_esdHiPilot_compute', tol: 0.002, input: { sectionVolume_ft3: 292, sectionGasTemp_F: 23, gasFlowRate_MMscfd: 39.28, esdResponseTime_s: 5, hiPilotSetting_psig: 112, rdSetting_psig: 125, mawp_psig: 125 },
expect: { pass: false, timeToReachRV_s: 0.6115 } } },
pitfalls: ['No Z-factor: treat a small margin as a fail.'],
refs: [{ std: 'ASME BPVC VIII-1 UG-134; API 520 Part I', note: 'relief set pressure' }, { std: 'API RP 14C', note: 'safety devices' }],
related: ['esdlo', 'prv', 'liquidline'],
shots: [Sh('view', 'both', 'ESD Hi-Pilot inputs', '', ['#wts_esdhi_loc~1']),
Sh('res', 'desktop', 'Computed Results table', RES, [], { target: '#wts_esdhi_results .dtable:nth-child(3)', setup: CL('#wts_esdhi_calc', '#wts_esdhi_results .dtable') })]
}),
esdlo: Gd('esdlo', '36f51fe8', {
keywords: ['PSL', 'leak'],
notDocumented: ['wts_esdlo_calc_btn~' + ST + '5', 'wts_esdlo_reset_btn~step 6'],
purpose: 'Checks that the lo-pilot (PSL) set point trips the ESD on a target leak in time, without false trips.',
what: ['A leak lowers the section pressure steadily. The PSL must sit the false-trip margin below the flowing pressure and be reached in time.'],
when: ['Setting a lo-pilot.', 'Checking that a small leak is seen.'],
steps: [{ t: HUB + 'ESD Lo-Pilot**.', shot: 'view' }, 'Choose the **Lo-Pilot Location** ①. **Custom…** keeps what you type.', 'Enter the **Detectable Leak Rate** ② and the **Required Detection Time**.',
'Set the **False-Trip Margin below P_flow**. Leave **PSL Set Point to Check** blank for the recommended value.', { t: CALC + 'and read the **Status** card.', shot: 'res' },
'**Reset Defaults** puts every field back.'],
inputs: ['Lo-Pilot Location~wts_esdlo_location~~Upstream of Heater Choke', 'Section Volume~wts_esdlo_volume~V~662', 'Section Flowing Pressure~wts_esdlo_pflow~p~662', 'Detectable Leak Rate~wts_esdlo_qleak~G~25',
'Section Gas Temperature~wts_esdlo_temp~t~60', 'WHSIP~wts_esdlo_whsip~p~2100~Reference only.', 'Required Detection Time~wts_esdlo_tresp~~5 s', 'False-Trip Margin below P_flow~wts_esdlo_margin~P~5',
'PSL Set Point to Check~wts_esdlo_psl~p~~Blank: flowing pressure less the margin.'],
outputs: ['PSL Setting~Recommended set point and trip window.'],
verdicts: ['✓~PASS — PSL trips~In time: use the recommended set point.', '⚠~PASS, but the drawdown~Drop under {{2|pressure}}: check the pilot can see it.',
'✗~inside the false-trip margin~Lower the set point.', '✗~at or below atmospheric~It never trips.', '✗~FAIL — the leak takes~Put the PSL nearer the leak.'],
example: { title: DEF, setup: ['{{662|volumeFt3}} at {{662|pressureG}}, leak {{25|gasRate}}, 5 s, margin {{5|pressure}}.', MET],
result: ['A drop of {{32.1|pressure|1}} in 5 s. ✓ PASS: the PSL of {{657|pressureG}} trips after 0.78 s.'],
check: { kind: 'compute', fn: 'WTS_esdLoPilot_compute', tol: 0.002, input: { sectionVolume_ft3: 662, sectionFlowingPressure_psig: 662, detectableLeakRate_MMscfd: 25, esdResponseTime_s: 5 },
expect: { pass: true, timeToTrip_s: 0.7782, psl_target_psig: 657 } } },
pitfalls: ['A real drawdown is slower: allow margin on the time.'],
refs: [{ std: 'API RP 14C', note: 'PSL set points' }, { std: 'API RP 521', note: 'depressuring' }],
related: ['esdhi', 'pipelife'],
shots: [Sh('view', 'both', 'ESD Lo-Pilot inputs', '', ['#wts_esdlo_location~1', '#wts_esdlo_qleak~2']),
Sh('res', 'desktop', 'Status card', RES, [], { target: '#wts_esdlo_status', setup: CL('#wts_esdlo_calc_btn', '#wts_esdlo_results .dtable') })]
}),
hydrate: Gd('hydrate', '24305ead', {
keywords: ['methanol', 'glycol'],
notDocumented: ['wts_hydrate_run~step 4', 'wts_hydrate_gocj~opens [[cheminj]]', '^(hy_(up|dn)_[PT]|hy_tgt|wts_hydrate_inj)_[023]$~same fields on the other segment cards'],
purpose: 'Hydrate temperature at four points of the spread, and the methanol or glycol rate that keeps each out of hydrates.',
what: ['Each card finds the hydrate temperature at its downstream pressure, then the inhibitor rate (Hammerschmidt) that puts it a margin below the target.'],
when: ['Will the choke form hydrates?', 'A quick inhibitor rate.'],
steps: [{ t: 'Select **Hydrate Management**' + TS, shot: 'view' }, 'In **System Inputs**, choose the **Inhibitor**, enter the **Free-water rate** and **Gas SG**.',
'On each segment card, enter the pressures, temperatures and **Operating-T target**.', 'Select **Recompute all nodes**. Each card shows a risk badge.',
'A blank **Local injection rate** takes the recommended rate.', { t: 'Read the **Inhibitor Injection Summary** ①.', shot: 'sum' }],
inputs: ['Upstream P~hy_up_P_1~p~2000', 'Upstream T~hy_up_T_1~t~105', 'Downstream P~hy_dn_P_1~p~885~Sets the hydrate temperature.', 'Downstream T~hy_dn_T_1~t~41',
'Operating-T target~hy_tgt_1~t~41~Coldest temperature to protect.', 'Local injection rate~wts_hydrate_inj_1~~~cc/min.', 'Inhibitor~wts_hydrate_inhib~~Methanol (MeOH)',
'Gas flow rate~wts_hydrate_q~G~25', 'Free-water rate~wts_hydrate_qw~Q~400', 'Gas SG~wts_hydrate_sg~s~0.78', 'Safety margin~wts_hydrate_safety~D~5'],
outputs: ['Risk badge~NO HYDRATE RISK, MARGINAL or HYDRATE RISK.', 'Inhibitor Injection Summary~Depression, wt %, rates.'],
example: { title: DEF, setup: ['Methanol, {{400|liquidRate}} water, gas SG 0.78.', MET],
result: ['After the choke: hydrates at {{65.6|temperature|1}}, HYDRATE RISK; 28.9 wt % methanol.'],
check: { kind: 'page', tol: 0.002, expectIds: { hy_thyd_1: 65.59 }, expectText: ['HYDRATE RISK — T_op below T_hyd'] } },
pitfalls: ['Sweet gas and free water only. Above about 30 wt % methanol, check on [[cheminj]].'],
refs: [{ std: 'Hammerschmidt equation', note: 'depression' }, { std: 'Towler and Mokhatab (2005)', note: 'hydrate temperature' }],
related: ['cheminj', 'wts', 'gaspvt'],
shots: [Sh('view', 'both', 'Hydrate segment cards', '', []),
Sh('sum', 'desktop', 'Summary table', RES, ['#wts_hydrate_summary .dtable~1'], T('#wts_hydrate_summary .dtable'))]
}),
cheminj: Gd('cheminj', 'dce43b73', {
keywords: ['MEG', 'pump', 'dosing'],
notDocumented: ['^cj_[a-z0-9]+_[2-6]$~lines 2 to 6 repeat line 1', '^cj_(co2|n2|api|sgw|wbasis|h2so|h2sw)$~Well stream details',
'^cj_(tck|htr|thtr|tsep|psvsep|whclass|haz|supgas|pbpv)$~Spread conditions details', '^cj_(thsrc|thuser|thuserp|method|cond|h2scus|pmpct|pmabs|ratebasis|psup|fc|glyloss|sour|band_[ga]|minf|adv_basis)$~Design basis options',
'^cj_[a-z0-9]+_1$~line options that follow the chemical and pump', '^cj_(cal|chart)_~step 8', '^cj_(sithp|fwhp)$~the two wellhead pressure rows'],
purpose: 'Plans hydrate inhibitor, H2S scavenger and treating-chemical injection per point, with pump settings and checks.',
what: ['The page checks the spread for hydrates and designs the inhibitor for the coldest point each line protects; other chemicals use ppm doses. Each line gets a rate, pump setting and pressure.'],
when: ['Hydrates, H2S or treating chemicals.', 'Setting injection pumps.'],
steps: [{ t: 'Select **Chemical Injection**' + TS, shot: 'view' }, 'Fill in **Well stream** ① and **Spread conditions**.', 'Check the hydrate margin and J-T factor in **Design basis**.',
'Choose the **Number of injection lines**; on each card choose the **Injection point**, **Chemical** and **Pump type**.', { t: 'Read the headline ②, then the **Spread hydrate check**.', shot: 'res' },
'Read **Pump setting** and **Discharge pressure**; compare **Pump options**.', 'Calibrate in **Field calibration check**.'],
inputs: ['Gas rate~cj_qg~G~10', 'Gas gravity~cj_sg~~0.65', 'H2S in gas~cj_h2s~~0 ppm', 'Oil / condensate rate~cj_qo~Q~0', 'Water rate~cj_qw~Q~2',
'Shut-in tubing head pressure~~p~3500', 'Flowing wellhead pressure~~p~3000', 'Flowing wellhead temperature~cj_fwht~t~110', 'Ambient / cold-tree temperature~cj_tamb~t~60',
'Pressure downstream of choke~cj_pck~p~1000', 'Choke outlet temperature from~cj_jt~~Real-gas isenthalpic × J-T factor', 'Separator pressure~cj_psep~p~1000', 'Hydrate design margin~cj_margin~D~10',
'J-T cooling design factor~cj_fjt~~1.1', 'Test duration~cj_days~~5 days', 'Number of injection lines~cj_nlines~~1', 'Injection point~cj_pt_1~~Flowhead / upstream of choke', 'Chemical~cj_chem_1~~Methanol',
'Pump type~cj_pump_1~~Air-driven liquid pump', 'Chemical tank usable volume~cj_tank_1~b~275'],
outputs: ['Rate~Per line.', 'Pump setting~SPM, stroke or air pressure.', 'Supply~Drive gas, tank days.'],
verdicts: ['⚠~Line 1:~Headline.', '⚠~Planning estimate~Calibrate.', '✓~no risk~Clear.', '⚠~within margin~Marginal.',
'✗~hydrate region~Hydrates without inhibitor.', '✓~is protected by line~Covered.', '⚠~Shut-in:~Strength for shut-in.', '⚠~Start-up:~Cold start-up needs more.', '⚠~extrapolated below~Outside the water-content range.',
'✓~feasible~Pump can deliver.', '✓~Recommended point~Good point.', '⚠~Air-driven pump: set~Verify the rate.', '⚠~Tank lasts~Plan totes.', '⚠~⚠~Line has a warning.', '⚠~Backflow:~Check valves and bleed.',
'⚠~Thermal relief~Relieve blocked liquid.'],
example: { title: DEF, setup: ['Methanol at the flowhead.', MET],
result: ['{{38.6|tempDelta|1}} depression; {{160|chemRate}} at air {{45.6|pressureG|1}}.'],
check: PG({ 'cheminj.total_gal_d': 159.95, 'cheminj.hydrate.dT': 38.566 }, { expectText: ['air 45.6 psig'] }) },
pitfalls: ['A planning estimate: calibrate each pump at line pressure.'],
refs: [{ std: 'API RP 500 / 505', note: 'classified areas' }],
related: ['hydrate', 'h2sroe', 'chem'],
shots: [Sh('view', 'both', 'Chemical Injection input cards', '', ['#cj_qg~1']), Sh('res', 'desktop', 'Headline verdict', RES, ['#cj_res .cj-v~2'], { target: '#cj_res .cj-v' })]
}),
liquidline: Gd('liquidline', '0e937304', {
keywords: ['blowby', 'LCV'],
notDocumented: ['wts_ll_calc_btn~' + ST + '4', 'wts_ll_gor~read-only, gas rate ÷ oil rate'],
purpose: 'Gas blowby through a failed-open separator dump valve: is a restrictive orifice needed, and does it protect the tank?',
what: ['If the level control valve (LCV) fails open, gas blows by to the tank. The page compares it with the vent capacity and checks the restrictive orifice (RO).'],
when: ['Rigging a separator to an atmospheric tank.', 'Choosing or checking the RO bore.'],
steps: [{ t: 'Select **Liquid Line / RO**' + TS, shot: 'view' }, 'In **Gas Blowby** ①, enter the **Separator Press**, rates, gravities and **LCV Size**.',
'Enter the **RO Size** in 64ths, the **Tank Max Design** and the **Vent Line** data.', { t: CALC + 'and read **RO Required?** and **RO Adequacy** ②.', shot: 'res' },
'Keep ignition out of the **Lean Flammability Footprint**.'],
inputs: ['Separator Press~wts_ll_sep_p~p~1440~Relief or design pressure.', 'Oil Rate~wts_ll_qoil~Q~2500', 'Oil Temp~wts_ll_t_oil~t~100~Also the gas temperature.', 'Oil SG~wts_ll_sg_oil~s~0.85',
'Gas SG~wts_ll_sg_gas~s~0.78', 'Gas Flow Rate~wts_ll_q_gas~G~25', 'LCV Size~wts_ll_lcv~~~Sets the Cv.', 'LCV Type~wts_ll_lcvtype', 'RO Size~wts_ll_ro_size~~58',
'Tank Max Design~wts_ll_tank_p~p~50', 'Tank Type~wts_ll_tank_type', 'NPS~wts_ll_vent_nps~~~Vent size.', 'Schedule~wts_ll_vent_sch', 'Length~wts_ll_vent_len~L~100', 'Wind Velocity~wts_ll_wind~W~20'],
outputs: ['Installed RO Throughput~Adequate below the vent capacity.'],
example: { title: DEF, setup: ['{{1440|pressureG}}, 58/64 RO.', MET],
result: ['Blowby {{313.6|gasRate|1}}, vent {{29.5|gasRate|1}}: RO needed. The RO passes {{26.2|gasRate|1}}: adequate.'],
check: { kind: 'compute', fn: 'WTS_liquidline_compute', tol: 0.002, input: { ro_size_64ths: 58 },
expect: { vent_max_capacity_MMscfd: 29.508, ro_max_throughput_MMscfd: 26.154 } } },
pitfalls: ['An RO bigger than the required bore leaves the tank unprotected.'],
refs: [{ std: 'API 520 Part I', note: 'critical gas flow' }],
related: ['sep', 'tank', 'esdhi'],
shots: [Sh('view', 'both', 'Liquid Line / RO inputs', '', ['#wts_ll_sep_p~1']), Sh('res', 'desktop', 'Results', RES, ['#wts_ll_results table~2'], T('#wts_ll_results table'))]
}),
pipelife: Gd('pipelife', '90d58266', {
keywords: ['erosion', 'sand'],
notDocumented: ['wts_pl_import~step 2', '^wts_pl_seg\\d_~segment table cells, listed below'],
purpose: 'Sand-erosion rate and remaining service life of each pipe segment from the wellhead to the flare.',
what: ['From each segment velocity: the erosion rate, the life to the minimum-spec wall and the MAWP. Hoses are not assessed.'],
when: ['A sandy clean-up.', 'After a wall survey.'],
steps: [{ t: 'Select **Pipe Service Life**' + TS, shot: 'view' }, 'Select **Use Well Test Simulator conditions** ① to import from [[wts]], or type the rates.',
'Enter the **Sand Production** ② and choose the **Erosion Model**.', 'In **Pipe Segments — Inputs** set each pipe and wall.',
{ t: 'Read **Limiting segment**, **Overall min RSL** and **Status** ③.', shot: 'res' }],
inputs: ['Sand Production~wts_pl_sand~S~50', 'Erosion Model~wts_pl_model~~DNV-RP-O501 pipe bend (default)', 'Sand Particle Size~wts_pl_dp~~250 µm', 'Bend Radius R/D~wts_pl_rd~~1.5',
'Geometry Factor GF~wts_pl_gf~~1', 'Legacy Fit Constant "c"~wts_pl_c~~300', 'Gas Rate~wts_pl_qg~G~10', 'Oil / Condensate Rate~wts_pl_qo~Q~1000', 'Water Rate~wts_pl_qw~Q~200',
'Gas SG~wts_pl_sg~s~0.65', 'Oil / Condensate SG~wts_pl_osg~s~0.80', 'Separator Bypass~wts_pl_bypass~~No'],
outputs: ['Remaining life~To the minimum-spec wall.', 'Status~OK; MITIGATE under 90 days; INSPECT NOW under 30 days or below a limit.'],
verdicts: ['✓~Imported rates~Check them.', '⚠~Schedule 180~Loaded as XXS.', '⚠~saved material~Check the material.'],
example: { title: DEF, setup: ['{{10|gasRate}}, {{50|sandLoading}}.', MET],
result: ['Choke → Heater: 9.7 days, INSPECT NOW.'],
check: PG({ 'pipelife.overall_min_life_days': 9.671 }, { expectIds: { wts_pl_status: 'ATTENTION' } }) },
tips: ['Velocity counts most.'],
refs: [{ std: 'DNV-RP-O501; Salama (2000)', note: 'sand erosion' }, { std: 'ASME B31.3', note: 'MAWP' }],
related: ['flowline', 'pipesz', 'wts'],
shots: [Sh('view', 'both', 'Operating Conditions and segments', '', ['#wts_pl_import~1', '#wts_pl_sand~2']), Sh('res', 'desktop', 'Summary figures', RES, ['#wts_pl_status~3'], T('#wts_pl_res > div:nth-child(2)'))]
}),
h2sroe: Gd('h2sroe', '2f22325a', {
keywords: ['sour', 'triazine'],
notDocumented: ['^hs_calc~step 5', 'hs_useaof~step 3'],
purpose: 'Radius of exposure for 100 and 500 ppm H2S, SO2 from flaring sour gas, and triazine-type scavenger dosing.',
what: ['The radius uses the Texas Statewide Rule 36 formula; the scavenger rate is the H2S removed times the product use.'],
when: ['Planning distances for a sour test.', 'Treating gas to an H2S limit.'],
steps: [{ t: 'Select **H2S Exposure & Scavenger**' + TS, shot: 'view' }, 'In **Radius of Exposure** ①, enter the **Maximum escape rate** and **H2S in gas**.',
'Or select **Use AOF from Gas Deliverability** ([[gasdeliv]]).', 'Fill in **SO2 from Flaring Sour Gas** and **H2S Scavenger Dosing**.', { t: CALC + 'or change a value; read the verdicts ②.', shot: 'res' }],
inputs: ['Maximum escape rate~hs_q~G~10~Producing well: the open-flow rate.', 'H2S in gas~hs_ppm~C~10000', 'Gas to flare~hs_fq~G~5', 'H2S in flared gas~hs_fppm~C~10000', 'Combustion efficiency~hs_fce~%~98',
'Gas to treat~hs_sq~G~5', 'Inlet H2S~hs_sin~C~50', 'Target outlet H2S~hs_sout~C~4', 'Product consumption per H2S removed~hs_ratio~y~1.5'],
outputs: ['Radius of Exposure~100 and 500 ppm radii.'],
verdicts: ['✓~radius of exposure is under~Small.', '⚠~check for public areas~A contingency plan may be needed.', '⚠~radius of exposure exceeds~Very large.', '⚠~check for public roads~Check roads.',
'✓~Outlet target meets~Meets 4 ppm.', '⚠~Outlet target is above~Above 4 ppm.', '⚠~Open Gas Deliverability~Calculate there first.'],
verdictCases: [{ hs_q: '0.01' }, { hs_q: '50' }, { hs_sout: '10' }],
example: { title: DEF, setup: ['{{10|gasRate}} at 10,000 ppm; scavenger 50 to 4 ppm.', MET],
result: ['Radii {{1798|length}} (100 ppm) and {{822|length}} (500 ppm). Scavenger {{31|chemRate}}.'],
check: PG({ 'h2sroe.x100_ft': 1798.3, 'h2sroe.scav_gal_d': 30.984 }) },
pitfalls: ['Local rules and dispersion studies come first.'],
refs: [{ std: '16 TAC §3.36 (Texas Statewide Rule 36)', note: 'radius of exposure' }, { std: 'API RP 55', note: 'H2S operations' }],
related: ['dispersion', 'flareghg', 'cheminj'],
shots: [Sh('view', 'both', 'H2S Exposure & Scavenger cards', '', ['#hs_q~1']), Sh('res', 'desktop', 'Radius of exposure', RES, ['#hs_roe_res .rbox~2'], { target: '#hs_roe_res' })]
}),
wellkill: Gd('wellkill', '757dd3a7', {
keywords: ['bullhead', 'brine'],
notDocumented: ['wk_calc~' + ST + '4', 'wk_gcalc~step 6', '^wk_(stvd|sfg)$~optional shoe check', '^wk_(ptvd|bmd|pbtd|tpmd|mu|rough)$~other depths and friction data', '^wk_g(len|mix|hl|rho|sg|t|z)$~column make-up'],
purpose: 'Kill-weight fluid, bullhead volume and strokes, surface pressure limits, U-tube check, brines, and column pressures.',
what: ['The kill card gives the kill weight, the bullhead volume and the surface limits against fracture. The gradient card gives a column pressure.'],
when: ['A bullhead kill.', 'A column pressure.'],
steps: [{ t: 'Select **Well Kill & Bullhead**' + TS, shot: 'view' }, 'In **Well & Kill Fluid** ①, enter the reservoir pressure, depth, **Overbalance** and fracture gradient.',
'In **Completion & Pumping**, choose the **Tubing**, then the depths and pump data.', { t: CALC + 'and read **Kill Fluid** and **Surface Pressure Limits**.', shot: 'res' },
'Pump to the **Static Pumping Schedule**.', 'For a column, use **Liquid / Mixed Gradient**.'],
inputs: ['Reservoir pressure at top perforation~wk_pres~P~5400', 'Top perforation TVD~wk_tvd~L~10000', 'Overbalance~wk_ob~P~200', 'Kill fluid density to use, blank = calculated~wk_kwo~d',
'Fracture gradient at top perforation, EMW~wk_fg~d~15', 'Well fluid density before the kill, EMW~wk_wf~d~1.9', 'Annulus / packer fluid density~wk_ann~d~8.6', 'Tubing~wk_tub',
'Casing / liner below packer~wk_cas', 'Packer MD~wk_pmd~L~9800', 'Top perforation MD~wk_tmd~L~10150', 'Displace to~wk_to', 'Over-displacement~wk_od~%~10', 'Pump output per stroke~wk_pump~v~0.1',
'Pump speed, strokes per minute~wk_spm~n~40', 'Pressure given at~wk_gdir', 'Known pressure~wk_gp~p~1500', 'Column TVD~wk_gtvd~L~10000'],
outputs: ['Bullhead Volume~Total and strokes.', 'Surface Pressure Limits~Start and end.'],
verdicts: ['✓~overbalance at the top~Kills the well.', '✗~below the balance density~Will not kill.', '⚠~below the calculated kill~Low overbalance.', '⚠~tailpipe annulus~Gas stays below the packer.',
'✗~at or above the fracture~Losses.', '✗~at or above the maximum~Would fracture.', '⚠~Narrow bullhead~Little room.', '✓~Bullhead window at~Room.', '✗~reaches zero~No limit left.',
'⚠~exceeds the static~Slow the pump.', '✓~stays below the static~Within limit.', '⚠~heavier than the annulus~U-tube.', '⚠~Annulus fluid is heavier~U-tube.', '✓~balance at the packer~Balanced.',
'⚠~go on vacuum~Level drops.', '✓~stays full~Full.', '✗~No clear brine~Weighted fluid.', '✓~Clear brines that~Brines.', '⚠~below atmospheric~Column falls.'],
verdictCases: [{ wk_kwo: '10' }, { wk_kwo: '10.5' }, { wk_fg: '10.6' }, { wk_tpmd: '9950' }],
example: { title: DEF, setup: ['{{5400|pressure}} at {{10000|length}}, overbalance {{200|pressure}}.', MET],
result: ['Kill weight {{10.77|densityLiquid|2}}, {{10.8|densityLiquid|1}} used; {{76.7|volume|1}} pumped, 767 strokes; maximum surface pressure {{6812|pressure}} at the start.'],
check: PG({ 'wellkill.kwf': 10.769, 'wellkill.strokes': 767, 'wellkill.maspStart': 6812 }) },
pitfalls: ['Static pressures: no gas migration.'],
refs: [{ std: 'API RP 59', note: 'well control' }, { std: 'API RP 13J', note: 'brines' }],
related: ['complfluids', 'casing'],
shots: [Sh('view', 'both', 'Well Kill input cards', '', ['#wk_pres~1']), Sh('res', 'desktop', 'Kill Fluid box', RES, [], { target: '#wk_res .rbox' })]
}),
complfluids: Gd('complfluids', '3fc40cf1', {
keywords: ['cement', 'slurry'],
notDocumented: ['cmf_calc~step 3', 'cmf_bcalc~step 5'],
purpose: 'Neat cement slurry water, yield, sacks and volumes, and the density of a blend of two clear brines.',
what: ['Water, yield and volume of a neat slurry from its density; the blend of two brines and the volumes for a target density.'],
when: ['A cement plug or casing job.', 'Making a brine from two stock brines.'],
steps: [{ t: 'Select **Cement & Brines**' + TS, shot: 'view' }, 'In **Cement Slurry** ①, enter the sizes, depths and **Open-hole excess**.',
{ t: 'Enter the **Slurry density**, select **Calculate** and read **Slurry Design**.', shot: 'res' }, 'In **Brine Blending**, choose **Brine A** and **Brine B**.', 'Enter a **Target density**; read the cautions.'],
inputs: ['Hole diameter~cmf_dh~l~8.5', 'Casing OD~cmf_od~l~7', 'Casing ID~cmf_cid~l~6.276', 'Casing shoe depth, MD~cmf_shoe~L~10000', 'Top of cement, MD~cmf_toc~L~8000', 'Shoe track length~cmf_track~L~80',
'Open-hole excess~cmf_ex~%~20', 'Slurry density~cmf_rho~d~15.8', 'Cement specific gravity~cmf_sgc~s~3.14', 'Sack weight~cmf_sack~m~94', 'Brine A~cmf_a', 'Brine A density~cmf_ra~d~14.2',
'Brine A volume~cmf_va~v~100', 'Brine B~cmf_b', 'Brine B density~cmf_rb~d~11.6', 'Brine B volume~cmf_vb~v~100', 'Target density, optional~cmf_tgt~d~13.0', 'Final blend volume for the target~cmf_vt~v~300'],
outputs: ['Slurry Volume & Sacks~Slurry, sacks, mix water, displacement.', 'Brine Blend~Density and target volumes.'],
verdicts: ['✓~normal neat-slurry~Normal.', '⚠~below about 0.35~Dispersant.', '⚠~above about 0.60~Free water.', '✗~above the usual maximum~Cannot be made.', '⚠~within 3 %~Crystallises easily.',
'⚠~Two different salts~Confirm TCT.', '⚠~Calcium brine with~Test compatibility.', '✓~No crystallisation~No flags.'],
verdictCases: [{ cmf_rho: '13' }, { cmf_rho: '17.5' }, { cmf_ra: '15' }, { cmf_a: '5', cmf_ra: '10', cmf_rb: '9', cmf_tgt: '' }, { cmf_b: '4', cmf_rb: '10' }],
example: { title: DEF, setup: ['{{8.5|lengthSmall}} hole, cement {{15.8|densityLiquid}} from {{10000|length}} to {{8000|length}}.', MET],
result: ['Yield {{1.146|volumeFt3|3}} per sack; {{57.3|volume|1}} slurry, 281 sacks. Blend {{12.9|densityLiquid|1}}.'],
check: PG({ 'complfluids.yieldFt3': 1.1465, 'complfluids.sacks': 280.46, 'complfluids.blendPpg': 12.9 }) },
pitfalls: ['Neat cement only: use the laboratory yield with additives.'],
refs: [{ std: 'API RP 10B-2', note: 'slurry yield' }, { std: 'API RP 13J', note: 'brines' }],
related: ['wellkill', 'casing'],
shots: [Sh('view', 'both', 'Cement and brine cards', '', ['#cmf_dh~1']), Sh('res', 'desktop', 'Slurry Design box', RES, [], { target: '#cmf_cres .rbox' })]
})
} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
