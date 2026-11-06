// prism-build/48-calc-help-utilities.js — Help content: Fluids & Utilities (docs/HELP-GUIDE-PLAN.md §4.2, WP-C9).
// Data only (no WTS_calcRegistry page). The factory runs on the first Help open (WTS_help.load()); nothing runs at load.
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;
G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];
G.WTS_helpContent.factories.push({ group: 'utilities', routes: ['gascalc', 'fluid', 'gaspvt', 'chem', 'scale', 'gensz', 'cablesz', 'vdrop', 'elec', 'units', 'analogsig'], build: function () {
var FU = ' in **Fluids & Utilities**.', EL = ['gensz', 'cablesz', 'vdrop', 'elec'];
// I input, O output, V verdict, N notDocumented pattern, S view shot, P page check, G0 common fields
function I(l, id, t) { var o = { label: l }; if (id) o.id = id; if (t) o.text = t; return o; }
function O(l, t) { return { label: l, text: t }; }
function V(m, k, t) { return { mark: m, match: k, text: t }; }
function N(p, w) { return [{ pattern: p, why: w }]; }
function S(alt, co, crop) {
  var c = function (l, k) { return l.map(function (s, i) { return { sel: s, n: k + i + 1 }; }); };
  var a = [{ id: 'view', view: 'both', alt: alt, caption: 'The page as it opens', callouts: c(co, 0) }];
  if (crop) a.push({ id: 'card', view: 'both', target: crop[0], alt: crop[1], caption: crop[1], callouts: c(crop[2], co.length) });
  return a;
}
function P(fn, set, txt, x) { var c = { kind: 'page', set: set || {}, expectText: txt }; if (fn) c.calc = fn; for (var k in x || {}) c[k] = x[k]; return c; }
function G0(r, src, kw, o) { o.route = r; o.reviewed = 'v3.3.2'; o.reviewedSrc = src; o.units = o.units || 'dual'; o.keywords = kw; return o; }
function sel(t) { return 'Select **' + t + '**' + FU; }
function hub(t) { return 'Select **Electrical**' + FU.slice(0, -1) + ', then **' + t + '** in the tabs.'; }
function rel(r, x) { return EL.filter(function (k) { return k !== r; }).concat(x || []); }
return { guides: {
gascalc: G0('gascalc', '086d3564', ['gas velocity', 'gas gradient', 'BHP'], {
purpose: 'Four quick gas checks: line velocity, a choke rate estimate, bottomhole pressure from a gas column and the gas gradient.',
what: ['Each card has its own button and result. All pressures here are absolute. **Use calculated Z** takes Z from [[gaspvt]] at the card’s conditions.'],
when: ['Check gas velocity in a line.', 'Estimate dry-gas rate through a choke.', 'Estimate a gas well’s bottomhole pressure.'],
steps: [{ t: sel('Gas Calculations'), shot: 'view' },
{ t: 'In **Gas Velocity**, enter Z, temperature, pressure, rate and **Line ID** ①; select **Calculate**. No Z? Select **Use calculated Z**.' },
{ t: 'In **Quick Gas Volume Estimate**, enter pressure and **Choke Size** in 64ths; select **Estimate**.' },
{ t: 'In **Gas Gradient & Downhole Pressure**, enter wellhead pressure, depth, average temperature and Z; select **Calculate**.' }],
inputs: [I('Z-factor, Temperature, Pressure, Gas Rate, Line ID', '', 'Gas Velocity card; Line ID is the bore.'), I('Gas Gravity', 'gv_sg', 'Air = 1; for Use calculated Z.'),
I('Use calculated Z', 'gv_usez', 'Sweet-gas Z, then calculates.'), I('Depth', 'gg_d', 'Vertical depth.'), I('Avg Temperature', 'gg_t', 'Absolute (°R).')],
notDocumented: N('^(gv_[ztpqd]|gq_[pd]|gg_(pwh|sg|z|usez)|gs_\\w+)$', 'named in the steps or the grouped row'),
outputs: [O('Bg, Gas Velocity', 'Volume factor and velocity.'), O('Gas Volume', 'Rule-of-thumb rate.'), O('BHP (exponential)', 'With a quick check and the column ΔP.'), O('Gas Gradient', 'Per foot.')],
example: { title: 'Gas Velocity defaults', setup: ['Z 0.9727, {{80|temperature}}, {{4000|pressure}}, {{40000|gasRateSmall}}, {{2.85|lengthSmall}}.'], result: ['Velocity {{38.88|velocity|2}}.'],
check: P('calcGasVel', {}, ['Gas Velocity38.88 ft/sec']) },
pitfalls: ['Add atmospheric pressure to gauge readings.', 'For a real choke use [[chokeflow]].'],
noRefs: 'Gas-law formulas and a rule of thumb.', related: ['gaspvt', 'pipesz', 'chokeflow'],
shots: S('Gas Calculations, four cards', ['#gv_d']) }),
fluid: G0('fluid', '8ade7cf4', ['API gravity', 'hydrometer', 'bubble point', 'shrinkage'], {
purpose: 'Corrects a hydrometer API gravity to standard temperature, and estimates bubble point and separator-oil shrinkage.',
what: ['Tabs: **API Gravity** (correction, SG ↔ API), **Bubble Point** (Standing, from the gas-oil ratio) and **Shrinkage Factor** (separator to stock tank).'],
when: ['After a hydrometer reading.', 'To check whether oil may be below its bubble point.'],
steps: [{ t: sel('Fluid Properties'), shot: 'view' },
{ t: 'Choose a tab ①.' },
{ t: 'On **API Gravity**, enter the observed gravity and temperature ②; select **Correct to 60°F**. **SG → API** and **API → SG** convert.' },
{ t: 'On the other tabs, enter separator and reservoir data and select the card’s button.' }],
inputs: [I('API Gravity', 'flt1', 'Tab.'), I('Bubble Point', 'flt2', 'Tab.'), I('Shrinkage Factor', 'flt3', 'Tab.'), I('Observed Temperature', 'fp_t', 'At the reading, not the line.'),
I('Other tabs', '', 'API, gas-oil ratio, gas gravity, separator pressure and temperature; reservoir temperature for the bubble point.')],
notDocumented: N('^fp_(api2?|sg)$', 'the gravity fields of step 3'),
outputs: [O('Corrected to standard', 'API, SG, density, VCF.'), O('Bubble Point Pressure', 'Absolute.'), O('Shrinkage Factor (1/Bo)', 'With Bo.')],
example: { title: 'Defaults', setup: ['42.8 °API at {{76|temperature}}.'], result: ['41.4 °API, VCF 0.991815.'], check: P('calcAPIcorr', {}, ['API @ 60°F41.4', 'Volume Correction Factor0.991815']) },
pitfalls: ['Standing is black-oil: condensates are estimates.'],
refs: [{ std: 'API MPMS Ch. 11.1 / ASTM D1250', note: 'API correction' }, { std: 'Standing (1947)', note: 'bubble point, Bo' }], related: ['oilgas', 'solgor', 'gaspvt'],
shots: S('Fluid Properties, API Gravity tab', ['#flt1', '#fp_api']) }),
gaspvt: G0('gaspvt', 'a342498a', ['Z-factor', 'DAK', 'sour gas', 'Fpv'], {
purpose: 'Natural-gas properties at one pressure and temperature: Z by two correlations, Bg, density, viscosity, cg, k and speed of sound.',
what: ['Sutton pseudo-criticals, Wichert–Aziz for sour gas, Z by Dranchuk–Abou-Kassem (DAK) and Hall–Yarborough (HY). A separator point adds Fpv.'],
when: ['You need Z, Bg or density.', 'The gas carries CO2 or H2S.'],
steps: [{ t: sel('Gas PVT'), shot: 'view' },
{ t: 'Enter gravity, absolute pressure, temperature ① and impurities in mol %. Optional: **Separator Conditions (optional)** ②.', shot: 'card' },
{ t: 'Select **Calculate** ③; the page also updates on every change.' },
{ t: 'Read **Z-factor** and **Checks**, then **Gas Properties**.' }],
inputs: [I('Gas gravity', 'gp_sg', 'Air = 1; at least 0.55.'), I('Temperature', 'gp_t', '{{-40|temperature}} to {{700|temperature}}.'), I('H2S', 'gp_h2s', 'CO2 or H2S applies Wichert–Aziz.'),
I('Separator pressure, absolute', 'gp_psep', 'Blank skips it.'), I('Calculate', 'gp_calc')],
notDocumented: N('^gp_(p|co2|n2|tsep)$', 'as their neighbours'),
outputs: [O('Pseudo-critical Properties', 'Tpc, Ppc, Tpr, Ppr.'), O('Gas Properties', 'From the DAK Z.'), O('At Separator Conditions', 'With Fpv.'), O('Z vs Pressure', 'Table and chart.')],
verdicts: [V('✓', 'agree within 1 %', 'Z agrees.'), V('⚠', 'differ by', 'Z uncertain.'), V('✓', 'inside the fitted range', 'In range.'), V('⚠', 'Tpr = ', 'Tpr out of range.'),
V('⚠', 'Ppr = ', 'Z extrapolated.'), V('⚠', 'Sutton data range', 'Gravity out of range.'), V('⚠', 'above the Wichert', 'Too sour.'), V('⚠', 'Sour gas', 'Correction applied.')],
verdictCases: [{ set: { gp_h2s: '10' } }, { set: { gp_p: '10500' } }, { set: { gp_t: '690' } }, { set: { gp_sg: '0.55' } }, { set: { gp_sg: '1.3', gp_co2: '60' } }, { set: { gp_t: '-30', gp_p: '1200' } }],
example: { title: 'Defaults', setup: ['0.7, {{3000|pressure}}, {{200|temperature}}.'], result: ['Z 0.8880 (DAK), 0.8856 (HY); density {{9.676|density|3}}.'],
check: { kind: 'compute', fn: 'WTS_gaspvt_compute', tol: 0.001, input: { sg: 0.7, p: 3000, t: 200, co2: 0, h2s: 0, n2: 0 }, expect: { zDAK: 0.888, zHY: 0.8856, rho: 9.676 } } },
pitfalls: ['For a rich or wet gas use a lab Z.'],
refs: [{ std: 'DAK (1975); Hall–Yarborough (1973); Wichert–Aziz (1972)', note: 'Z' }, { std: 'AGA Report No. 3', note: 'Fpv' }], related: ['gascalc', 'aga3', 'hydrate'],
shots: S('Gas PVT inputs and results', ['#gp_sg'], ['#gp_root .card:nth-child(2)', 'Separator card and Calculate', ['#gp_psep', '#gp_calc']]) }),
chem: G0('chem', '71a7e9b1', ['dosage', 'ppm', 'chloride'], {
purpose: 'Chemical injection rates in cc/min from flow and ppm dosage, and chlorides by silver-nitrate titration.',
what: ['Rate = flow × ppm × 0.0001104. For injection points and pumps use [[cheminj]].'],
when: ['Setting antifoam or demulsifier pump rates.', 'Checking water salinity.'],
steps: [{ t: sel('Chemical & Dosage'), shot: 'view' },
{ t: 'Enter the **Flow Rate** ①. Type a **Product** and **Dosage**, then select **+ Add**; ✕ removes a row.' },
{ t: 'Select **Calculate All** to refresh the rates.' },
{ t: 'For chlorides, enter A, B, N and D and select **Calculate**.' }],
inputs: [I('Flow Rate', 'ch_q'), I('Dosage', 'ch_ppm', 'ppm by volume.'), I('A: Silver Nitrate Used', 'cl_a', 'ml; at least B.'), I('N: AgNO₃ Strength', 'cl_n', 'Normality.')],
notDocumented: N('^(ch_prod|cl_[bd])$', 'name, blank and sample volume'),
outputs: [O('Rate (cc/min)', 'Per row.'), O('Chloride Results', 'Chlorides, NaCl, rough brine gradient.')],
example: { title: 'Defaults', setup: ['{{12000|liquidRate}}; 1, 10, 30 ppm; 29.3 ml of 0.1 N on 1 ml.'], result: ['1.32, 13.25, 39.75 cc/min; 103,868.5 ppm.'],
check: P('calcChloride', {}, ['Antifoam11.32', 'Chlorides (ppm Cl⁻)103,868.5']) },
pitfalls: ['Added rows are not saved.'],
refs: [{ std: 'Standard Methods 4500-Cl⁻ B', note: 'chloride' }], related: ['cheminj', 'scale'],
shots: S('Chemical & Dosage', ['#ch_q']) }),
scale: G0('scale', '238919f8', ['water analysis', 'saturation index', 'calcite', 'barite'], {
purpose: 'Screens a water analysis for scale: charge balance, carbonate indices and saturation indices for five minerals.',
what: ['From the analysis in mg/L: charge balance, Langelier and Stiff–Davis, and Oddo–Tomson saturation indices (SI) at your conditions and against temperature.'],
when: ['Before mixing waters.', 'To decide where inhibitor is needed.'],
steps: [{ t: sel('Scale & Water Analysis'), shot: 'view' },
{ t: 'Enter the ions ①, pH, and temperature and pressure ②. Blank TDS = sum of ions.', shot: 'card' },
{ t: 'Select **Calculate** ③; the page also updates on every change.' },
{ t: 'Check the charge balance first, then each verdict.' }],
inputs: [I('Ion fields', '', 'mg/L; blank is 0. Calcium and alkalinity needed.'), I('pH, measured', 'sc_ph', '3 to 11.'), I('Pressure', 'sc_p', 'Absolute.'), I('Calculate', 'sc_calc')],
notDocumented: N('^sc_(na|k|ca|mg|ba|sr|fe|cl|so4|hco3|co3|tds|t)$', 'ions, TDS, temperature (step 2)'),
outputs: [O('Water Analysis', 'meq/L, balance, ionic strength.'), O('Oddo–Tomson Saturation Indices', 'SI 0 = saturated.')],
verdicts: [V('✓', 'analysis acceptable', 'Within 5 %.'), V('⚠', 'questionable', 'Check the analysis.'), V('✗', 'poor (above', 'Resample.'),
V('✓', 'undersaturated', 'SI ≤ 0.'), V('⚠', 'marginal scaling', 'SI 0 to 0.5.'), V('✗', 'scale likely', 'Plan inhibition.'),
V('⚠', 'Langelier index is outside', 'TDS too high.'), V('⚠', 'Stiff–Davis chart', 'K extrapolated.'), V('⚠', 'Langelier chart fit', 'Use Oddo–Tomson.')],
verdictCases: [{ set: { sc_na: '34600' } }, { set: { sc_na: '40000' } }, { set: { sc_ba: '70' } }, { set: { sc_t: '250' } },
{ set: { sc_na: '1000', sc_k: '0', sc_ca: '200', sc_mg: '0', sc_ba: '0', sc_sr: '0', sc_fe: '0', sc_cl: '1900', sc_t: '230' } }],
example: { title: 'Default brine', setup: ['86,280 mg/L, pH 6.8, {{180|temperature}}, {{2000|pressure}}.'], result: ['Balance 0.13 % ✓; calcite SI 0.83 ✗.'],
check: P('calcScale', {}, ['Charge balance 0.13 %'], { expectState: { 'scale.si.calcite': 0.8335 } }) },
pitfalls: ['Mixed waters: enter the blend.'],
refs: [{ std: 'Oddo–Tomson (1994); ASTM D3739; ASTM D4582', note: 'indices' }], related: ['chem', 'cheminj'],
shots: S('Scale & Water Analysis', ['#sc_na'], ['#sc_root .card:nth-child(2)', 'Conditions card and Calculate', ['#sc_t', '#sc_calc']]) }),
gensz: G0('gensz', '32a9a7c8', ['generator', 'kVA', 'motor starting'], {
purpose: 'Estimates generator kVA from running loads and the worst motor starts, and picks a standard size.',
what: ['Starting adds the three largest motor starts (kW × start factor). The larger of running and starting ÷ 1.6 gets × 1.32 for growth and margin.'],
when: ['Sizing a set for a spread or camp.', 'Adding a motor.'],
steps: [{ t: hub('Generator Sizing'), shot: 'view' },
{ t: 'Enter **Non-Motor Loads** ①, **Power Factor** and **Generator Voltage**.' },
{ t: 'List motors ②; **+ Add Motor** adds a row. Choose **Starting Mode**; select **Calculate**.' }],
inputs: [I('Non-Motor Loads', 'gs_nm', 'Lights, heaters.'), I('Starting Mode', 'gs_mode', 'Starting multiplier.'), I('Motor rows', '', 'DOL 5, star-delta 2.2, soft starter 2.5, VFD 1.2.')],
notDocumented: N('^gs_(pf|v)$', 'step 2'),
outputs: [O('Recommended', 'kVA and kW.'), O('Standard Size', 'Next rating.')],
example: { title: 'Defaults', setup: ['50 kW, pf 0.8, 480 V; 30 kW DOL, 2 × 15 kW star-delta.'], result: ['Start 365.8 kVA; 350 kVA set.'], check: P('calcGenSz', {}, ['Standard Size350 kVA']) },
tips: ['Soft starters cut the set size.'], noRefs: 'Rule-of-thumb factors.', related: rel('gensz'),
shots: S('Generator Sizing', ['#gs_nm', '#gs_motors']) }),
cablesz: G0('cablesz', 'c7a944a7', ['cable', 'ampacity'], {
purpose: 'Picks the smallest copper cable that carries the derated load with at most 5 % voltage drop.',
what: ['Each size is listed with derated ampacity and drop. Length is in metres and ambient in degrees Celsius.'],
when: ['Powering a pump or cabin.', 'A long run.'],
steps: [{ t: hub('Cable Sizing'), shot: 'view' },
{ t: 'Choose **System**; enter voltage, **Load Current** ① and power factor.' },
{ t: 'Enter length, **Laying Method** and **Ambient Temp**; select **Calculate**.' }],
inputs: [I('Laying Method', 'cs_lay', 'Derating factor.'), I('Ambient Temp', 'cs_amb', 'Above 60 refused.')],
notDocumented: N('^cs_(sys|v|i|pf|l)$', 'steps 2 and 3'),
outputs: [O('Recommended', 'With OK or FAIL per size.')],
example: { title: 'Defaults', setup: ['3-phase, 415 V, 50 A, 100 m.'], result: ['“Recommended: 16 mm²”.'], check: P('calcCableSz', {}, ['Recommended: 16 mm²']) },
pitfalls: ['Grouping is not derated.'],
refs: [{ std: 'IEC 60364-5-52; IEC 60228', note: 'derating' }], related: rel('cablesz'),
shots: S('Cable Sizing', ['#cs_i']) }),
vdrop: G0('vdrop', '889cfb24', ['voltage drop', 'XLPE'], {
purpose: 'Checks one cable’s voltage drop against 5 % for power loads or 3 % for sensitive equipment.',
what: ['OK up to the limit, WARNING to 1.25 × the limit, then NOT OK.'],
when: ['A new load on an old cable.', 'Supplying instruments.'],
steps: [{ t: hub('Voltage Drop'), shot: 'view' },
{ t: 'Choose **Load Type** ① and **System**; enter the circuit data.' },
{ t: 'Choose **Cable Size**, **Conductor** and **Insulation**; select **Calculate**.' }],
inputs: [I('Load Type', 'vd_lt', 'Sets the limit.'), I('Cable Size', 'vd_mm', 'Square millimetres.')],
notDocumented: N('^vd_(sys|v|i|pf|l|con|ins)$', 'steps 2 and 3'),
outputs: [O('Voltage Drop Results', 'Drop, end voltage, status.')],
example: { title: 'Defaults', setup: ['415 V, 80 A, 150 m, size 50 copper.'], result: ['2.31 %: OK.'], check: P('calcVDrop', {}, ['Drop %2.31 %', 'StatusOK']) },
pitfalls: ['Motor starts drop far more.'],
refs: [{ std: 'IEC 60228', note: 'resistance' }], related: rel('vdrop'),
shots: S('Voltage Drop', ['#vd_lt']) }),
elec: G0('elec', 'cbc614dd', ['motor current', 'HP', 'mud pump'], {
purpose: 'Three-phase motor current, kW ↔ HP conversion and triplex mud-pump output.',
what: ['Current = kW × 1000 / (√3 × V × pf); start-up about 7 ×.'],
when: ['Checking a motor supply.', 'Setting pump strokes.'],
steps: [{ t: hub('Electrical & Pumps'), shot: 'view' },
{ t: 'Fill **3-Phase Motor Current** ①; select **Calculate**. **kW → HP** and **HP → kW** convert.' },
{ t: 'Fill **Mud Pump Output (Triplex)**; select **Calculate**.' }],
inputs: [I('Power Rating', 'el_kw', 'kW.'), I('Number of Pumps', 'mp_n', '1 to 6.')],
notDocumented: N('^(el_(v|pf|kw2|hp)|mp_(d|sl|eff|spm))$', 'self-describing'),
outputs: [O('Full Load Current', 'Amps.'), O('Pump Output', 'Per stroke, total.')],
example: { title: 'Defaults', setup: ['100 kW, 440 V, pf 0.875.'], result: ['150 A.'], check: P('calcElec', {}, ['Full Load Current150 Amps']) },
pitfalls: ['Triplex only.'], noRefs: 'Standard formulas.', related: rel('elec', ['pumpsz']),
shots: S('Electrical & Pumps', ['#el_v']) }),
units: G0('units', '0cf1dc8d', ['convert', 'psi to bar'], { units: 'none',
purpose: 'Converts oilfield units: rates, pressure, temperature, length, density, viscosity, volume, energy and mass.',
what: ['**Quick Reference** lists every unit of the group. The Metric setting does not change this page.'],
when: ['A sheet uses other units.', 'Checking a reading.'],
steps: [{ t: sel('Unit Conversions'), shot: 'view' },
{ t: 'Select a group tab ①, for example **Pressure**.' },
{ t: 'Type in **From** ②, choose both units; ⇄ swaps.' }],
inputs: [I('From', 'uc_val'), I('⇄', 'uc_swap', 'Swaps units.')],
notDocumented: N('^uc_(from|to|res)$', 'unit lists and the result'),
outputs: [O('Quick Reference', 'A dash: not physical.')],
example: { title: 'Gas rate', setup: ['1000 SCF/D.'], result: ['28.31682 Sm3/d.'], check: P(null, { uc_val: '1000' }, ['Sm3/d28.31682']) },
pitfalls: ['No gauge or absolute.'], noRefs: 'Fixed factors.', related: ['analogsig', 'gaspvt'],
shots: S('Unit Conversions', ['#pgBody .tabs', '#uc_val']) }),
analogsig: G0('analogsig', '44de7fd0', ['4-20 mA', 'NAMUR'], { units: 'none',
purpose: 'Converts between a 4–20 mA signal, a 0–10 V signal and the scaled process value.',
what: ['A mA value outside the NAMUR NE 43 range, or in its fault band, gets a message.'],
when: ['Checking [[modbus]] scaling.', 'Commissioning a loop.'],
steps: [{ t: sel('Analog Signal'), shot: 'view' },
{ t: 'Choose **Input Type** ①.' },
{ t: 'Enter **Input Value**, **Lo Range** ② and **Hi Range**; select **Calculate**.' }],
inputs: [I('Lo Range', 'as_lo', 'At 4 mA.'), I('Hi Range', 'as_hi', 'At 20 mA.')],
notDocumented: N('^as_(type|val)$', 'steps 2 and 3'),
outputs: [O('Conversion Results', 'mA, V, value, %.')],
example: { title: 'Mid-scale', setup: ['12 mA, 0 to 100.'], result: ['5 V, 50 %.'], check: P('calcAnalogSig', {}, ['Voltage5 V', 'Percentage50 %']) },
tips: ['At 3.6 mA or less suspect the wire.'], refs: [{ std: 'NAMUR NE 43', note: 'signal levels' }], related: ['modbus', 'units'],
shots: S('Analog Signal', ['#as_type', '#as_lo']) })
} };
} });
})();

// === SELF-TEST ===
(function () { /* content is checked by tests/help-content.test.js */ })();
