// =============================================================================
// WTS — 49-calc-dfit-info.js  (Round 9)
// -----------------------------------------------------------------------------
// helper module: does not add a page to window.WTS_calcRegistry
//
// DFIT method notes (docs/DFIT-PLAN.md §3.9, §6.13; owner WP6):
//   window.WTS_dfitInfo = { notes, keys(), groups(), content(key), open(key, opener, mount), close(), isOpen(), css() }
//
//   notes[key] = { key, group, title, lead, assumptions:[text], failureModes:[text], distinguish, cites:[text] }
//     one neutral note per closure method (tangent, sqrt, maxdpdg, compliance, crel, loglog, varcomp, model, fissure,
//     reopening, user), per closure family (F0–F4), per leak-off type, per after-closure regime and per ISIP method,
//     plus 'index' (the list the Tools entry "Method notes" opens). Notes are labelled by method, never by person or
//     school, and present the closure dispute as open. Citations are author, year, title and SPE number only.
//   open(key, opener, mount) → the <dialog id="wts_dfit_info" class="rp-skip" data-rp-nosnap> (never captured by reports
//     or autosave), mounted in #pgBody (navigation removes it) or the body; Esc, the × / Close buttons and a backdrop
//     click close it; focus returns to the opener. Unknown keys open the index. No document is needed to load this file;
//     open() returns null without one.
//
// Pure data + one dialog; no timers, no storage, no events.
// =============================================================================

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;

    function _esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function _own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    // ── References (author, year, title, SPE number; plan §13, verified numbers only) ──
    var R = {
        nolte79: 'Nolte, K.G. 1979. Determination of fracture parameters from fracturing pressure decline. SPE 8341.',
        nolte86: 'Nolte, K.G. 1986. A general analysis of fracturing pressure decline with application to three models. SPE 12941.',
        nolteSmith81: 'Nolte, K.G. and Smith, M.B. 1981. Interpretation of fracturing pressures. SPE 8297.',
        castillo87: 'Castillo, J.L. 1987. Modified fracture pressure decline analysis including pressure-dependent leakoff. SPE 16417.',
        barree98: 'Barree, R.D. 1998. Applications of pre-frac injection/falloff tests in fissured reservoirs — field examples. SPE 39932.',
        barree09: 'Barree, R.D., Barree, V.L. and Craig, D.P. 2009. Holistic fracture diagnostics: consistent interpretation of prefrac injection tests using multiple analysis methods. SPE 107877.',
        barree15: 'Barree, R.D., Miskimins, J.L. and Gilbert, J.V. 2015. Diagnostic fracture injection tests: common mistakes, misfires, and misdiagnoses. SPE 169539.',
        barreeMuk96: 'Barree, R.D. and Mukherjee, H. 1996. Determination of pressure dependent leakoff and its effect on fracture geometry. SPE 36424.',
        bachman12: 'Bachman, Walters and Hawkes 2012. Reappraisal of the G time concept in mini-frac analysis. SPE 160169.',
        craig17: 'Craig, D.P., Barree, R.D., Warpinski, N.R. and Blasingame, T.A. 2017. Fracture closure stress: reexamining field and laboratory experiments of fracture closure using modern interpretation methodologies. SPE 187038.',
        craigBla06: 'Craig, D.P. and Blasingame, T.A. 2006. Application of a new fracture-injection/falloff model accounting for propagating, dilated, and closing hydraulic fractures. SPE 100578.',
        liu15: 'Liu and Ehlig-Economides 2015. Comprehensive global model for before-closure analysis of an injection falloff fracture calibration test. SPE 174906.',
        mcclure16: 'McClure, M.W., Jung, H., Cramer, D.D. and Sharma, M.M. 2016. The fracture-compliance method for picking closure pressure from diagnostic fracture-injection tests. SPE 179725.',
        mcclure17: 'McClure, M.W. 2017. The spurious deflection on log-log superposition-time derivative plots of diagnostic fracture-injection tests. SPE 186098.',
        mcclure22: 'McClure, Fowler and Picone 2022. Best practices in DFIT interpretation: comparative analysis of 62 DFITs from nine different shale plays. SPE 205297.',
        zanganeh17: 'Zanganeh, B., Clarkson, C.R. and Hawkes, R.V. 2017. Reinterpretation of fracture closure dynamics during diagnostic fracture injection tests. SPE 185649.',
        hubbert57: 'Hubbert, M.K. and Willis, D.G. 1957. Mechanics of hydraulic fracturing. SPE 686-G.',
        haimson67: 'Haimson, B. and Fairhurst, C. 1967. Initiation and extension of hydraulic fractures in rocks. SPE 1710.',
        nolteACA97: 'Nolte, K.G., Maniere, J.L. and Owens, K.A. 1997. After-closure analysis of fracture calibration tests. SPE 38676.',
        nolteBg97: 'Nolte, K.G. 1997. Background for after-closure analysis of fracture calibration tests. SPE 39407.',
        talley99: 'Talley, G.R., Swindell, T.M., Waters, G.A. and Nolte, K.G. 1999. Field application of after-closure analysis of fracture calibration tests. SPE 52220.',
        soliman05: 'Soliman, M.Y., Craig, D., Bartko, K., Rahim, Z. and Adams, D. 2005. After-closure analysis to determine formation permeability, reservoir pressure, and residual fracture properties. SPE 93419.',
        gu93: 'Gu, H., Elbel, J.L., Nolte, K.G., Cheng, A.H.-D. and Abousleiman, Y. 1993. Formation permeability determination using impulse-fracture injection. SPE 25425.',
        mohamed11: 'Mohamed, I.M. et al. 2011. Evaluation of after-closure analysis techniques for tight and shale gas formations. SPE 140136.',
        marongiu11: 'Marongiu-Porcu, M., Ehlig-Economides, C.A. and Economides, M.J. 2011. Global model for fracture falloff analysis. SPE 144028.',
        cinco81: 'Cinco-Ley, H. and Samaniego-V., F. 1981. Transient pressure analysis for fractured wells. SPE 7490.',
        bourdet89: 'Bourdet, D., Ayoub, J.A. and Pirard, Y.M. 1989. Use of pressure derivative in well-test interpretation. SPE 12777.',
        barker88: 'Barker, J.A. 1988. A generalized radial flow model for hydraulic tests in fractured rock.',
        cramer13: 'Cramer, D.D. and Nguyen, D.H. 2013. Diagnostic fracture injection testing tactics in unconventional reservoirs. SPE 163863.',
        nordgren72: 'Nordgren, R.P. 1972. Propagation of a vertical hydraulic fracture. SPE 3009.',
        carey15: 'Carey, M.A., Mondal, S. and Sharma, M.M. 2015. Analysis of water hammer signatures for fracture diagnostics. SPE 174866.',
        iriarte17: 'Iriarte, J., Merritt, J. and Kreyche, B. 2017. Using water hammer characteristics as a fracture treatment diagnostic. SPE 185087.',
        holz85: 'Holzhausen, G.R. and Gooch, R.P. 1985. Impedance of hydraulic fractures: its measurement and use for estimating fracture closure pressure and dimensions. SPE 13892.',
        crump88: 'Crump, J.B. and Conway, M.W. 1988. Effects of perforation-entry friction on bottomhole treating analysis. SPE 15474.',
        romero95: 'Romero, J., Mack, M.G. and Elbel, J.L. 1995. Theoretical model and numerical investigation of near-wellbore effects in hydraulic fracturing. SPE 30506.',
        bandis83: 'Bandis, S.C., Lumsden, A.C. and Barton, N.R. 1983. Fundamentals of rock joint deformation.'
    };

    // note(key, group, title, lead, assumptions, failureModes, distinguish, citeKeys)
    var NOTES = {};
    var ORDER = [];
    function note(key, group, title, lead, ass, fail, dist, cites) {
        NOTES[key] = { key: key, group: group, title: title, lead: lead, assumptions: ass, failureModes: fail, distinguish: dist,
            cites: cites.map(function (c) { return R[c]; }) };
        ORDER.push(key);
    }

    // ── Closure methods ──────────────────────────────────────────────────
    note('tangent', 'method', 'Tangent to G·dP/dG (end of stiffening)',
        'A straight line through the origin is drawn to touch the G·dP/dG curve; closure is read where the data leave that line for good.',
        ['Leak-off is proportional to 1/√t over a fracture of constant area after shut-in (the G-function idealisation).',
         'The fracture keeps a constant compliance until the reading point, so pressure falls linearly in G.',
         'tp, the shut-in time and the efficiency exponent α are right; a wrong tp bends the curve at small G.'],
        ['A pressure-dependent leak-off hump draws the tangent early and high unless the hump is excluded.',
         'Concave-up data (contact or height recession) place the departure late and low if the first-stiffening reading is right.',
         'Large wellbore storage (low closure visibility) gives a weak departure that is hard to place.'],
        'The tangent marks the end of the concave-up section; the compliance method marks its start. Where the two differ, the data do not decide which is mechanical closure, and every downstream number is shown for both readings.',
        ['nolte79', 'nolte86', 'castillo87', 'barree09', 'barree15']);
    note('sqrt', 'method', 'Square-root-of-time inflection',
        'Closure is read at the largest |dP/d√t| (or where √t·dP/d√t leaves a line through the origin).',
        ['Linear flow from a closing fracture face before closure; the same leak-off idealisation as the G plot.'],
        ['Several inflections (leak-off hump, water hammer, thermal drift) give several candidates.',
         'The second derivative amplifies noise.',
         'It only differs from the tangent when the dimensionless closure time is small; otherwise it repeats the same evidence.'],
        'The √t pick is a dependent member of the end-of-stiffening family: it never confirms a tangent pick and never votes.',
        ['nolteSmith81', 'barree09', 'barree15']);
    note('maxdpdg', 'method', 'Maximum dP/dG',
        'Closure is read at the G of the dP/dG maximum.',
        ['As for the tangent: constant-area leak-off before closure.'],
        ['As for the tangent; a noisy derivative moves the maximum.'],
        'A dependent member of the end-of-stiffening family (it reads the same evidence as the tangent) and never votes.',
        ['barree09', 'castillo87']);
    note('compliance', 'method', 'Compliance method (first stiffening)',
        'A straight line is fitted to the early G·dP/dG (through the origin when the intercept is small); closure is read where the data first rise above it for good.',
        ['The early falloff reflects an open fracture of constant compliance plus the wellbore storage.',
         'The first rise of G·dP/dG above the line is the onset of compliance loss as the faces start to touch.'],
        ['Any other cause of a rising dP/dG (height recession, gas break-out, gauge thermal drift) triggers it.',
         'A leak-off hump or tip extension biases the early line.',
         'The departure tolerance and the noise level move the pick.'],
        'The compliance pick marks the onset of stiffening; the tangent marks its end. On normal leak-off they coincide; on concave-up data they separate and the module reports a range.',
        ['mcclure16', 'craig17', 'mcclure22']);
    note('crel', 'method', 'Compliance drop',
        'Closure is read at the first pressure where the relative system compliance falls below 1 − ε for several points.',
        ['As for the compliance method: constant compliance above closure.'],
        ['As for the compliance method.'],
        'A dependent member of the first-stiffening family (it repeats the compliance evidence) and never votes.',
        ['mcclure16']);
    note('loglog', 'method', 'Log-log derivative departure',
        'Closure is read at the first upward departure of the Bourdet derivative from the open-fracture reference curve, on Δt.',
        ['The reference curve is the constant-compliance falloff for the chosen tp and α.',
         'When the early line passes through the origin this test is the compliance test with another tolerance and smoothing variable.'],
        ['The Bourdet smoothing window shifts the pick by about half the window in ln Δt.',
         'A wrong tp shifts the reference curve.',
         'Late-time deflections on log-log superposition plots can be spurious.'],
        'It votes only when the early line does not pass through the origin (it then reads different evidence from the compliance method).',
        ['bourdet89', 'mcclure17', 'barree09']);
    note('varcomp', 'method', 'Variable-compliance fit',
        'A forward model with a pressure-dependent aperture below closure is fitted to dp/dG; its closure stress is a cross-check.',
        ['The aperture law below closure (hyperbolic or a decaying residual) describes the contact.',
         'The wellbore storage and the reservoir pressure are known and held fixed.'],
        ['The result depends on the aperture-law form.',
         'Pressure-dependent leak-off and the contact law can trade off.',
         'When the data stop soon after closure, closure stress and the contact scale correlate strongly (reported).'],
        'A model-based cross-check: its band is its own confidence interval and it never enters the vote.',
        ['mcclure16', 'zanganeh17', 'craig17']);
    note('model', 'method', 'Leak-off model closure',
        'Closure stress read from a history match of the leak-off mini-model (mechanical closure, contact onset).',
        ['The mini-model geometry, contact law and leak-off law describe the test.'],
        ['The contact law is built into the answer; a different law gives a different closure.'],
        'A cross-check only: it never votes.',
        ['craigBla06', 'nordgren72', 'liu15']);
    note('fissure', 'method', 'Fissure opening (leak-off hump end)',
        'The end of the pressure-dependent leak-off hump, where G·dP/dG returns to the line through the origin; read as the fissure-opening pressure.',
        ['The hump comes from natural fissures that dilate above their opening pressure.'],
        ['It is not the main closure; tip extension and storage changes can also bend the early curve.'],
        'Family F0: a reading of the fissure-opening pressure, never a closure vote.',
        ['barreeMuk96', 'barree98', 'castillo87']);
    note('reopening', 'method', 'Reopening (re-pressurisation knee)',
        'The knee of a later pressure-up ramp (a second cycle, a pump-in before flowback or a planned ramp after closure).',
        ['Below the knee the wellbore alone is compressed; above it the fracture takes fluid.',
         'The knee is corrected for the near-wellbore loss at the ramp rate when a step-down exists.'],
        ['Near-wellbore stress concentration and tortuosity read high (an upper-side bound when uncorrected).',
         'A ramp that starts above closure has no knee.',
         'A soft (gas-cut) wellbore makes the knee faint.'],
        'Family F4 is the only injection-side evidence; uncorrected it is an upper-side bound that can veto a single closure above it.',
        ['hubbert57', 'haimson67', 'cramer13']);
    note('user', 'method', 'User pick',
        'A closure typed, clicked or dragged by the analyst, with a required reason in the pick log.',
        ['The analyst sees evidence the automatic methods do not use (core, logs, offset tests).'],
        ['A pick that is not checked against the frictional limits and the bounds can be inconsistent; the bounds check still runs.'],
        'A user pick votes in the family it is assigned to; it is logged and can be undone.',
        ['barree15', 'mcclure22']);

    // ── Families ─────────────────────────────────────────────────────────
    note('F0', 'family', 'Family F0 — fissure opening',
        'Readings of the fissure-opening pressure (the end of the leak-off hump and the p vs dP/dt break).',
        ['Pressure-dependent leak-off through natural fissures above their opening pressure.'],
        ['Tip extension or a storage change can mimic a hump.'],
        'Informational: F0 never votes.',
        ['barreeMuk96', 'barree98']);
    note('F1', 'family', 'Family F1 — first stiffening',
        'Readings of the onset of compliance loss: contact of the faces or the start of height recession.',
        ['Its one independent member is the compliance method; the compliance drop and (usually) the log-log departure repeat its evidence.'],
        ['Other causes of a rising dP/dG trigger it early.'],
        'F1 and F2 are two readings of the same falloff; the module shows both with every downstream number when they differ.',
        ['mcclure16', 'craig17']);
    note('F2', 'family', 'Family F2 — end of stiffening',
        'Readings of the end of the concave-up section of G·dP/dG.',
        ['Its one independent member is the tangent; the √t inflection and max dP/dG repeat its evidence.'],
        ['A leak-off hump draws it early; concave-up data put it late.'],
        'The dispute between the F1 and F2 readings is open; neither is assumed right.',
        ['nolte86', 'barree09']);
    note('F3', 'family', 'Family F3 — model-based cross-checks',
        'The variable-compliance fit and the leak-off model closure.',
        ['A forward model with an assumed aperture or contact law.'],
        ['Model dependence; correlation between closure stress and the contact scale.'],
        'Cross-checks: F3 never votes and never enters the consensus mean.',
        ['mcclure16', 'craigBla06']);
    note('F4', 'family', 'Family F4 — reopening',
        'Knees of re-pressurisation ramps after closure.',
        ['A clear knee and, for a mean, a near-wellbore correction.'],
        ['Reads high without the correction (upper-side bound).'],
        'The only family read from injection-side evidence; independent of the falloff families.',
        ['hubbert57', 'haimson67']);

    // ── Leak-off types ───────────────────────────────────────────────────
    note('type-normal', 'type', 'Normal leak-off',
        'G·dP/dG is a straight line through the origin up to closure.',
        ['Constant fracture area and compliance after shut-in; leak-off controlled by the filtrate and wall.'],
        ['Large wellbore storage hides small departures.'],
        'The closure families agree; a single closure is expected.',
        ['nolte79', 'barree09']);
    note('type-matrix', 'type', 'Normal, reservoir-controlled (matrix)',
        'dP/dG falls towards closure by the amount expected from reservoir-controlled leak-off at the reservoir pressure.',
        ['The leak-off driving force (p − p_r) falls as the pressure falls.'],
        ['A wrong reservoir pressure changes the expected decline.'],
        'The decline of dP/dG is compared with the expectation from p_r before any other reading is made.',
        ['barree09', 'nolteBg97']);
    note('type-pdl', 'type', 'Pressure-dependent leak-off',
        'A hump above the line through the origin early in the falloff, ending at the fissure-opening pressure.',
        ['Natural fissures dilate above their opening pressure and leak-off rises.'],
        ['Tip extension also gives an early hump; the hump biases the tangent.'],
        'The fissure-opening pressure is reported in family F0; the tangent excludes the hump.',
        ['barreeMuk96', 'castillo87']);
    note('type-tip', 'type', 'Tip extension',
        'G·dP/dG below the line through the origin early in the falloff: the fracture keeps growing after shut-in.',
        ['Fluid in the fracture keeps moving to the tip after shut-in.'],
        ['Can be confused with storage effects at small G.'],
        'Efficiency and geometry are less reliable while the area grows.',
        ['barree09', 'nolte86']);
    note('type-hr-contact', 'type', 'Height recession or asperity contact',
        'Concave-up G·dP/dG: the system stiffens before the end-of-stiffening reading.',
        ['Either the fracture recedes from bounding layers or the faces start to touch on asperities.'],
        ['The two causes fit equally well from the falloff alone.'],
        'The closure range reflects this; independent evidence (logs, a reopening ramp) is needed to choose.',
        ['craig17', 'mcclure16', 'bandis83']);
    note('type-storage', 'type', 'Storage-dominated',
        'The wellbore takes a large share of the falloff volume; the closure signature is faint.',
        ['A soft wellbore (gas or air in the column) or a large wellbore volume against a small fracture.'],
        ['Low closure visibility; departures are weak in every method.'],
        'Closure visibility is checked before any label above low is given.',
        ['mcclure16', 'barree15']);
    note('type-undetermined', 'type', 'Undetermined leak-off type',
        'No leak-off signature scores clearly above the others.',
        ['The falloff is too short, too noisy or affected by an artefact.'],
        ['Labels may be wrong in any direction.'],
        'The scores and the evidence sentences are shown so the analyst can decide.',
        ['barree15']);

    // ── After-closure regimes ────────────────────────────────────────────
    note('aca-linear', 'aca', 'After-closure linear flow',
        'Slope −½ on the derivative after closure: pseudolinear flow from the closed fracture.',
        ['The fracture behaves as a short impulse source of the leaked-off volume; the time origin is the closure-volume centroid by default.'],
        ['An early time origin or residual conductivity changes the slope; a short shut-in gives a short window.'],
        'Linear flow brackets p_i and gives the group of the fracture length and k; k alone needs the length.',
        ['nolteACA97', 'nolteBg97', 'talley99']);
    note('aca-bilinear', 'aca', 'After-closure bilinear flow',
        'Slope −¾: a closed fracture with finite residual conductivity.',
        ['Residual conductivity in the closed fracture.'],
        ['Can be a transition between storage and linear flow.'],
        'Hands off to a finite-conductivity fracture model.',
        ['cinco81', 'soliman05']);
    note('aca-radial', 'aca', 'After-closure pseudoradial flow',
        'Slope −1: radial flow around the closed fracture, the regime that gives kh/μ.',
        ['The shut-in is long enough for the pressure disturbance to become radial.'],
        ['A penny-shaped fracture or a steepening trend can show −1 transiently (false radial).'],
        'kh/μ is reported only when the slope holds and does not keep steepening.',
        ['nolteACA97', 'gu93', 'soliman05']);
    note('aca-spherical', 'aca', 'After-closure spherical flow',
        'Slope −³⁄₂: flow converging in three dimensions (partial penetration or a small fracture).',
        ['The fracture height is small against the formation thickness.'],
        ['Noise at late time can steepen the derivative.'],
        'The flow dimension n(t) is shown to check it.',
        ['barker88', 'mohamed11']);
    note('aca-storage', 'aca', 'After-closure storage',
        'Unit slope after closure: the wellbore or a leak dominates.',
        ['A near-constant leak (valve, casing, packer or another zone) or wellbore storage.'],
        ['Masks the reservoir regimes.'],
        'Check the leak plot and the annulus before reading p_i.',
        ['soliman05', 'barree15']);
    note('aca-transition', 'aca', 'After-closure transition',
        'No constant slope: between regimes.',
        ['The data have not reached a regime long enough to read.'],
        ['Bounds on k and a p_i bracket are reported instead of point values.'],
        'Bounds and brackets come from the trends of every method.',
        ['marongiu11', 'mohamed11']);
    note('aca-artefact', 'aca', 'After-closure artefact',
        'A slope that no flow regime gives (tides, gauge drift, thermal effects, a leak).',
        ['Gauge stability and a sealed wellbore.'],
        ['Misread as a regime.'],
        'Excluded from the regime summary and listed in triage.',
        ['barree15']);

    // ── ISIP methods ─────────────────────────────────────────────────────
    note('isip-wh', 'isip', 'ISIP from the water-hammer midline',
        'The midline of the damped pressure oscillation after shut-in, with the friction bleed-off term.',
        ['A high-rate record (≥ 2.3 Hz at the wellhead) through shut-in.'],
        ['An upper estimate while friction bleed-off has not died out at the end of the fit window.'],
        'Independent of the falloff (wave family).',
        ['carey15', 'iriarte17', 'holz85']);
    note('isip-g', 'isip', 'ISIP from the early G line',
        'The early straight line on the G plot extrapolated to G = 0.',
        ['Normal leak-off in the early falloff.'],
        ['A leak-off hump or tip extension bends the early line.'],
        'Falloff family.',
        ['nolte79', 'barree09']);
    note('isip-sd', 'isip', 'ISIP from the step-down intercept',
        'Intercept of the step-down fit of pressure against rate (perforation and near-wellbore terms removed).',
        ['Settled steps and a stable fracture during the steps.'],
        ['Unsettled steps make it an outlier.'],
        'Friction family.',
        ['crump88', 'romero95']);
    note('isip-lp', 'isip', 'ISIP from the last pump pressure',
        'The last pumping pressure minus the perforation, tortuosity and pipe-friction losses.',
        ['Friction terms known from a step-down or the pipe model.'],
        ['Fluid viscosity in the fracture adds a correction.'],
        'Friction family.',
        ['crump88', 'romero95']);

    var INDEX_GROUPS = [
        ['method', 'Closure methods'], ['family', 'Closure families'], ['type', 'Leak-off types'],
        ['aca', 'After-closure regimes'], ['isip', 'ISIP methods']
    ];

    // key aliases: classification types and AcaDiag regimes as the engines spell them
    function _resolve(key) {
        key = String(key == null ? '' : key);
        if (_own(NOTES, key)) return key;
        if (_own(NOTES, 'type-' + key)) return 'type-' + key;
        if (_own(NOTES, 'aca-' + key)) return 'aca-' + key;
        if (_own(NOTES, 'isip-' + key)) return 'isip-' + key;
        return 'index';
    }

    function content(key) {
        var k = _resolve(key);
        if (k === 'index') return { ok: true, key: 'index', title: 'DFIT method notes', lead: 'Neutral notes on every closure method and family, the leak-off types, the after-closure regimes and the ISIP methods: what each assumes, how it fails and what would distinguish it from the competing reading.', index: INDEX_GROUPS.map(function (g) {
            return { group: g[0], title: g[1], items: ORDER.filter(function (x) { return NOTES[x].group === g[0]; }).map(function (x) { return { key: x, title: NOTES[x].title }; }) };
        }) };
        var n = NOTES[k];
        return { ok: true, key: k, group: n.group, title: n.title, lead: n.lead, assumptions: n.assumptions.slice(),
                 failureModes: n.failureModes.slice(), distinguish: n.distinguish, cites: n.cites.slice() };
    }

    var DISC = 'Closure readings are disputed in the literature; this note describes the method and its failure modes without endorsing one reading.';
    function _bodyHTML(c) {
        var h = '<p class="wdi-lead" id="wts_dfit_info_lead">' + _esc(c.lead) + '</p>';
        if (c.index) {
            c.index.forEach(function (g) {
                h += '<h4>' + _esc(g.title) + '</h4><div class="wdi-idx">' + g.items.map(function (it) {
                    return '<button type="button" class="btn btn-secondary wdi-go" data-dfit-note="' + _esc(it.key) + '">' + _esc(it.title) + '</button>';
                }).join('') + '</div>';
            });
            return h;
        }
        h += '<h4>Assumptions</h4><ul>' + c.assumptions.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        h += '<h4>Failure modes</h4><ul>' + c.failureModes.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        h += '<h4>Against the competing reading</h4><p>' + _esc(c.distinguish) + '</p>';
        h += '<h4>References</h4><ul class="wdi-refs">' + c.cites.map(function (a) { return '<li>' + _esc(a) + '</li>'; }).join('') + '</ul>';
        h += '<p class="wdi-disc">' + _esc(DISC) + '</p>';
        h += '<p><button type="button" class="btn btn-secondary wdi-go" data-dfit-note="index">All method notes</button></p>';
        return h;
    }

    var CSS = '#wts_dfit_info{position:fixed;inset:0;z-index:10050;display:none;align-items:center;justify-content:center;box-sizing:border-box;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:16px;border:0;background:rgba(1,4,9,.72);color:var(--text)}' +
        '#wts_dfit_info[open]{display:flex}#wts_dfit_info::backdrop{background:transparent}' +
        '#wts_dfit_info .wdi-box{display:flex;flex-direction:column;width:min(760px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
        '#wts_dfit_info .wdi-hd{display:flex;gap:12px;align-items:flex-start;padding:14px 16px 10px;border-bottom:1px solid var(--border)}' +
        '#wts_dfit_info .wdi-hd h3{flex:1;min-width:0;margin:0;font-size:16px;color:var(--accent);overflow-wrap:anywhere}' +
        '#wts_dfit_info .wdi-x{flex:none;width:32px;height:32px;border:0;background:transparent;color:var(--text2);font-size:22px;cursor:pointer}' +
        '#wts_dfit_info .wdi-bd{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 16px 4px;font-size:13px;line-height:1.55;overflow-wrap:anywhere}' +
        '#wts_dfit_info .wdi-bd h4{margin:12px 0 4px;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text3)}' +
        '#wts_dfit_info .wdi-bd ul{margin:4px 0 8px;padding-left:20px}' +
        '#wts_dfit_info .wdi-idx{display:flex;flex-wrap:wrap;gap:6px}' +
        '#wts_dfit_info .wdi-disc{margin:12px 0;padding:8px 10px;border-left:3px solid var(--yellow);background:rgba(210,153,34,.08)}' +
        '#wts_dfit_info .wdi-ft{display:flex;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--border)}' +
        '@media (max-width:600px){#wts_dfit_info{padding:10px}#wts_dfit_info .wdi-box{max-height:calc(100vh - 20px);max-height:calc(100dvh - 20px)}}';
    function css() { return CSS; }
    function _ensureCss() {
        if (typeof document === 'undefined' || !document.getElementById || document.getElementById('wts_dfit_info_css')) return;
        var s = document.createElement('style');
        s.id = 'wts_dfit_info_css';
        s.textContent = CSS;
        var h = document.head || document.body;
        if (h && h.appendChild) h.appendChild(s);
    }

    var _cur = null;   // {ov, opener, modal}
    function isOpen() { return !!(_cur && _cur.ov && _cur.ov.parentNode); }
    function close(noFocus) {
        var c = _cur;
        _cur = null;
        if (!c) return false;
        var ov = c.ov;
        if (ov && c.modal && ov.open && typeof ov.close === 'function') { try { ov.close(); } catch (e) { /* removal below */ } }
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        if (noFocus !== true && c.opener && typeof c.opener.focus === 'function') { try { c.opener.focus(); } catch (e) { /* best effort */ } }
        return true;
    }
    function _fill(ov, c) {
        ov.setAttribute('data-note', c.key);
        ov.innerHTML = '<div class="wdi-box" tabindex="-1"><div class="wdi-hd"><h3 id="wts_dfit_info_title">' + _esc(c.title) + '</h3>' +
            '<button type="button" class="wdi-x" data-dfit-close aria-label="Close">×</button></div>' +
            '<div class="wdi-bd" tabindex="0" role="document">' + _bodyHTML(c) + '</div>' +
            '<div class="wdi-ft"><button type="button" class="btn btn-secondary" data-dfit-close>Close</button></div></div>';
    }
    function _onClick(e) {
        if (!_cur) return;
        var t = e.target;
        if (t === _cur.ov) { close(); return; }
        var go = (t && t.closest) ? t.closest('[data-dfit-note]') : null;
        if (go && _cur.ov.contains(go)) { _fill(_cur.ov, content(go.getAttribute('data-dfit-note'))); return; }
        var b = (t && t.closest) ? t.closest('[data-dfit-close]') : null;
        if (b && _cur.ov.contains(b)) close();
    }
    function _onKey(e) {
        if (!_cur) return;
        if (e.key === 'Escape' || e.key === 'Esc') { if (e.preventDefault) e.preventDefault(); close(); }
    }
    function _onCancel(e) { if (_cur && e.target === _cur.ov) { if (e.preventDefault) e.preventDefault(); close(); } }

    function open(key, opener, mount) {
        if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return null;
        var c = content(key);
        close(true);
        _ensureCss();
        var host = mount || document.getElementById('pgBody') || document.body;
        if (!host || !host.appendChild) return null;
        var ov = document.createElement('dialog');
        ov.id = 'wts_dfit_info';
        ov.className = 'rp-skip';
        ov.setAttribute('data-rp-nosnap', '');
        ov.setAttribute('role', 'dialog');
        ov.setAttribute('aria-modal', 'true');
        ov.setAttribute('aria-labelledby', 'wts_dfit_info_title');
        ov.setAttribute('aria-describedby', 'wts_dfit_info_lead');
        _fill(ov, c);
        host.appendChild(ov);
        _cur = { ov: ov, opener: opener || null, modal: false };
        ov.addEventListener('click', _onClick);
        ov.addEventListener('keydown', _onKey);
        ov.addEventListener('cancel', _onCancel);
        if (typeof ov.showModal === 'function') { try { ov.showModal(); _cur.modal = true; } catch (e) { _cur.modal = false; } }
        if (!_cur.modal) ov.setAttribute('open', '');
        var box = ov.querySelector('.wdi-bd');
        if (box && typeof box.focus === 'function') { try { box.focus(); } catch (e) { /* best effort */ } }
        return ov;
    }

    var I = G.WTS_dfitInfo = G.WTS_dfitInfo || {};   // merge, never replace
    if (!I.notes || typeof I.notes !== 'object') I.notes = {};
    ORDER.forEach(function (k) { I.notes[k] = NOTES[k]; });
    I.keys = function () { return ORDER.slice(); };
    I.groups = function () { return INDEX_GROUPS.map(function (g) { return g[0]; }); };
    I.resolve = _resolve;
    I.content = content;
    I.open = open;
    I.close = function () { return close(false); };
    I.isOpen = isOpen;
    I.css = css;
    I.refs = R;
})();

// === SELF-TEST ===
(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var I = G.WTS_dfitInfo, bad = [];
    if (!I || typeof I.content !== 'function') return;
    ['tangent', 'sqrt', 'maxdpdg', 'compliance', 'crel', 'loglog', 'varcomp', 'model', 'fissure', 'reopening', 'user',
     'F0', 'F1', 'F2', 'F3', 'F4'].forEach(function (k) {
        var c = I.content(k);
        if (!c.ok || c.key !== k || !c.assumptions.length || !c.failureModes.length || !c.cites.length) bad.push(k);
    });
    if (I.content('nonsense').key !== 'index') bad.push('index fallback');
    if (bad.length && typeof console !== 'undefined') console.warn('[49-calc-dfit-info self-test] ' + bad.join(', '));
})();
