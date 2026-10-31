// ════════════════════════════════════════════════════════════════════
// WTS — Round-9 shared data module — chemical injection library (chemlib)
//
// PURPOSE
//   Planning data for the Chemical Injection page (route `cheminj`,
//   prism-build/49-calc-cheminj.js): the generic chemicals, the generic
//   pump presets, the injection points, the chemical-family × point
//   suitability matrix, the pairwise compatibility rules, the capillary
//   lines and the elastomer screening table (docs/CHEMICAL-INJECTION-PLAN.md
//   §3 and §5). It is a data module: it deliberately does NOT add a page to
//   window.WTS_calcRegistry, so it has no sidebar button or tile. The file
//   lives in the 4N-calc- namespace only so concat-round9.js picks it up
//   ahead of the calculators (40-calc-chemlib sorts before 40-calc-tubulars).
//
//   Every chemical and pump is named by its generic chemistry or type only.
//   All values are planning defaults, editable on the page; replace them with
//   data-sheet and nameplate values. Confidence tags: H high, M medium, L low.
//
// UNITS (field units, like the rest of the app)
//   SG at 60 °F (water = 1); mu68 = viscosity at 68 °F, cP; muB = Andrade B, K
//   (μ(T) = mu68·exp(muB·(1/T_K − 1/293.15))); water = water MASS FRACTION of
//   the product as supplied (0–1); activeDef = % active; leanDef/leanMin/leanMax
//   = wt % of the as-injected solution (thermodynamic inhibitors only); beta =
//   liquid compressibility, 1/psi; alphaV = volumetric thermal expansion, 1/°F;
//   dPdT = alphaV/beta = blocked-in pressure rise, psi/°F; flashF, freezeF °F;
//   dose in the units of its basis (bases[basis].unit); pump rates gal/h,
//   plunger and stroke inches, pressures psi.
//
// PUBLIC API (window.WTS_chemlib) — arrays are read-only by convention (copy before editing)
//   version                       data version (number)
//   groups[]                      {key, label, order}           purpose groups (<optgroup> order)
//   families[]                    {key, label, group, kind, scavPhase, suit{point: R|A|N|X}, notes{point: text}}
//                                 kind: 'thi' | 'ldhi' | 'scavenger' | 'ppm' | 'custom'
//   chemicals[]                   see CHEMICAL RECORD below (30 records, 'custom' last)
//   bases{}                       dose bases keyed by basis key (§4.9): {key, label, unit, phase, product, twin, factor}
//   points[]                      the 9 injection points in flow order (§3.1): see POINT RECORD below
//   pointKeys[]                   ['dh','wh','dsch','sepin','sepgas','flare','sepoil','sepwat','tank']
//   pumps[]                       see PUMP RECORD below (8 records)
//   plungers[], strokes[], actuators[]   {in, value, frac, mm, label}  (value = String(in), label "3/8 in (9.5 mm)")
//   heads[]                       [1, 2, 3]
//   capillary[]                   {key, od, wall, id, idMm, barlowPsi, label}
//   compat[]                      {key, a[], b[]|null, ctx|null, level:'bad'|'warn', text}
//                                 pair rule when b is set (tags of two chemicals); context rule when ctx is set
//   elastomer                     {materials[], rows{rowKey: {label, NBR, HNBR, EPDM, 'FKM std', 'FKM peroxide', FFKM, PTFE}}, note}
//   fluidClasses{}                {methanol|ethanol|glycol|aqueous|solvent: {beta, alphaV, label}}
//   constants{}, defaults{}       physical constants (§4) and the decided design-basis defaults (Q5, Q17, Q18, Q19)
//   find(key)                     chemical record or null
//   list(familyOrGroup?)          chemicals in that family or purpose group (all when omitted)
//   family(key), point(key), pump(key), cap(key)   record or null
//   suit(chemKey, pointKey)       'R' | 'A' | 'N' | 'X'  (null for an unknown key)
//   suitInfo(chemKey, pointKey)   {level, verdict:'ok'|'warn'|'bad', note}  (null for an unknown key)
//   eff(chemKey, pointKey)        default scavenger utilisation η (chemical effDef, else the point's etaScav), or null
//   pairRules(chemKeyA, chemKeyB) compat pair rules that match the two chemicals' incompat tags
//   ctxRules(chemKey)             compat context rules that apply to one chemical
//   elastomerRow(chemKey)         elastomer row or null
//
// CHEMICAL RECORD
//   {key, name, short, family, group, kind, basis, dose, doseMin, doseMax,
//    leanDef, leanMin, leanMax, activeDef, sg, mu68, muB, water, fluidClass,
//    beta, alphaV, dPdT, flashF, freezeF, flammable, oxidiser, vapourLoss,
//    aqueous, peak, points[], suit{} (point overrides of the family matrix),
//    incompat[], elastomer, stoich {mw, n, activePct} | null, effDef,
//    thi {hamKey, M, Mham, K, nb, warnPct, maxPct} | null,
//    ldhi {subMaxF, subAdvF, needsLHC, maxWaterCutPct} | null,
//    freezeCurve [[wt %, °F], …] | null, bestTempF [lo, hi] | null, muLean | null,
//    cautions, conf}
//   dose null = computed: thermodynamic inhibitors from the hydrate design,
//   stoichiometric scavengers from stoich ÷ η; 'custom' has user values.
//   thi.hamKey is the 25-hydrate.js inhibitor key ('methanol' | 'meg' | 'deg' |
//   'teg') or null (ethanol: compute Hammerschmidt locally with M and K);
//   thi.nb false = Hammerschmidt only (DEG, TEG).
//
// POINT RECORD
//   {key, order, branch, label, short, pLine, pBack, pBackClass, tBasis,
//    phases {gas, water, oil}, wellbore, upstreamOfSep, contactSegs[],
//    contactSegsHeater[], etaScav, pumpClass, note}
//   pLine: dosing / P_req basis — 'dh' tubing pressure at depth, 'wh' max(SITHP, FWHP),
//          'ck' downstream of choke, 'sep' separator, 'bpv' downstream of the
//          back-pressure valve, 'atm' 0 psig.
//   pBack: 'sithp' | 'psvsep' | 'none'; pBackClass is the full-class basis ('whclass' | 'psvsep' | 'none').
//   tBasis: 'dh' | 'fwht' | 'ck' | 'htr' | 'sep' | 'bpv'.
//   contactSegs: Card-2 pipe segments (1 flowhead→choke, 2 choke→heater inlet,
//   3 heater coil, 4 heater→separator) from the point to the separator;
//   contactSegsHeater applies when the heater is on (sepin = heater outlet).
//   order is the position along the point's branch (well → separator → outlets).
//
// PUMP RECORD
//   {key, name, short, kind, setting, mvp, electric, vents, hazSuitable, hazAreaNote,
//    plungers[]|null, plungerDef, strokes[]|null, strokeDef, strokeMax, headsMax,
//    actuators[]|null, actDef, spmMax, spmMin, spmCrank, spmCrankMin, spmCrankMax,
//    sMin, nMin, vfd, pmaxRule, bodyPsi, pmax, rodLbf, capPsi, etaM, pSpring,
//    qRated_galh, q0_galh, ratio, vcyc_in3, stallFracMax, q0FracMin, etaDef,
//    accuracy, turndown, bestPoints[], conf}
//   kind: 'plunger' | 'meter' | 'airliquid' | 'transfer' | 'hand'
//   setting: 'spm' (pneumatic plunger) | 'stroke_speed' (metering pumps and the
//   electric plunger: % stroke × % speed) | 'air' (air-driven liquid pump) |
//   'cycles' (air-operated diaphragm) | 'batch' (hand pump)
//   pmaxRule: 'pneumatic' (η_m·P_s·A_act/(n_h·A_pl), capped by bodyPsi) |
//   'rod' (rodLbf/A_pl, capped by capPsi) | 'fixed' (pmax) | 'ratio' (ratio × drive pressure)
//   mvp false = not offered in the 3.2a pump select (hand pump: Phase 2).
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var G = (typeof window !== 'undefined') ? window : globalThis;

    var POINT_KEYS = ['dh', 'wh', 'dsch', 'sepin', 'sepgas', 'flare', 'sepoil', 'sepwat', 'tank'];

    function _r(x, d) { var f = Math.pow(10, d); return Math.round(x * f) / f; }
    function _has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
    function _frac(x) {
        var whole = Math.floor(x + 1e-9), rem = x - whole, n = Math.round(rem * 64), d = 64;
        if (n === 0) return String(whole);
        while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
        return (whole ? whole + '-' : '') + n + '/' + d;
    }
    function _size(x) {
        var mm = x * 25.4, shown = mm >= 100 ? Math.round(mm + 1e-9).toFixed(0) : (Math.round(mm * 10 + 1e-9) / 10).toFixed(1);
        return { 'in': x, value: String(x), frac: _frac(x), mm: _r(mm, 4), label: _frac(x) + ' in (' + shown + ' mm)' };
    }

    // ── Constants (§4) ────────────────────────────────────────────────
    var CONSTANTS = {
        lbPerGalWater: 8.337,            // lb/gal water at 60 °F
        lbPerBblWater: 350.2,            // lb/bbl water at 60 °F
        psiPerFtPerSg: 0.4335,           // 0.052 × 8.337, the WTS_gradient_compute constant
        galToL: 3.785411784,
        in3PerGal: 231,
        mLPerIn3: 16.387064,
        galPerBbl: 42,
        mLminPerGalD: 2.62876,           // 1 gal/d = 2.62876 mL/min
        LhPerGalD: 0.157725,             // 1 gal/d = 0.157725 L/h
        galDPerMLs: 22.8245,             // 1 mL/s = 22.8245 gal/d
        galDPerSpmD2L: 4.896,            // Q gal/d = 4.896·d²·L·SPM·ηv (d, L in)
        mwH2S: 34.081, mwMeOH: 32.04, mwWater: 18.015, mwO2: 31.998, mwSO2: 64.064,
        usPintML: 473.176
    };

    // ── Decided design-basis defaults (plan §2.3; user decisions Q5, Q17, Q18, Q19) ──
    var DEFAULTS = {
        marginF: 10,                     // Q5: hydrate margin with the correlation hydrate temperature
        marginMinF: 5,                   // allowed with a user / lab hydrate temperature
        fJT: 1.10,                       // Q17: J-T cooling design factor (1.00–1.30)
        fJTMin: 1.00, fJTMax: 1.30,
        fJTRelaxed: 1.05,                // Q17: the user may relax to 1.05
        sourPerMolF: 5,                  // sour adder per mol % H2S (1–3 mol %), flat for CO2 > 5 mol %
        sourNoAdderMolPct: 0.1,          // H2S ≤ 0.1 mol % (1,000 ppm): no adder
        sourMaxMolPct: 3,                // Q18: above 3 mol % H2S the correlation dose is refused unless a user T_hyd is entered
        co2AdderMolPct: 5, co2MaxMolPct: 20,
        thiDefaultPump: 'air_liquid',    // Q19: default pump for the hydrate (H1) line
        thiDefaultChem: 'meoh',
        thiDefaultPoint: 'wh',
        pumpMarginPct: 10, pumpMarginPsi: 100,
        dpQuillPsi: 50,
        bandGreenPct: 70, bandAmberPct: 85, bandLowPct: 20, bandMinPct: 10,
        minRateFactor: 0.5,
        spmMinStable: 3,
        peakThi: 2.0, peakScav: 1.5, peakOther: 1.25,
        etaV: 0.90,
        heelPct: 10, toteGal: 275, toteUsableFrac: 0.9, contingencyPct: 20,
        psupPsig: 100, testDays: 5, tcReqS: 15,
        glyLossPct: 1, fcLbPerBbl: 0.25,
        segments: [{ len_ft: 20, id_in: 2.9 }, { len_ft: 60, id_in: 3.826 }, { len_ft: 200, id_in: 2.9 }, { len_ft: 80, id_in: 3.826 }]
    };

    // ── Fluid classes: compressibility β (1/psi) and thermal expansion α_v (1/°F) [§4.10.2, §4.11.1] ──
    var FLUID = {
        methanol: { label: 'methanol',                     beta: 8.6e-6, alphaV: 6.6e-4 },   // 77 psi/°F
        ethanol:  { label: 'ethanol',                      beta: 7.7e-6, alphaV: 6.1e-4 },   // ≈ 79 psi/°F [M]
        glycol:   { label: 'glycol',                       beta: 2.5e-6, alphaV: 3.5e-4 },   // 140 psi/°F [L]
        aqueous:  { label: 'water-based product',          beta: 3.1e-6, alphaV: 1.18e-4 },  // ≈ 38 psi/°F
        solvent:  { label: 'hydrocarbon-solvent product',  beta: 7.0e-6, alphaV: 5.6e-4 }    // 80 psi/°F [L]
    };

    // ── Purpose groups (<optgroup> order) ────────────────────────────
    var GROUPS = [
        { key: 'hydrate',   label: 'Hydrate inhibitors',  order: 1 },
        { key: 'h2s',       label: 'H2S scavengers',      order: 2 },
        { key: 'corrosion', label: 'Corrosion inhibitors', order: 3 },
        { key: 'scale',     label: 'Scale inhibitors',    order: 4 },
        { key: 'process',   label: 'Foam and emulsion',   order: 5 },
        { key: 'flow',      label: 'Wax and asphaltene',  order: 6 },
        { key: 'water',     label: 'Water systems',       order: 7 },
        { key: 'custom',    label: 'Custom',              order: 8 }
    ];

    // ── Families and the family × point suitability matrix (§3.3) ────
    // R recommended (✓), A allowed (✓ + note), N not recommended (⚠ + reason), X not applicable (✗).
    var X_NOTE = 'Not applicable at this point.';
    function _fam(key, label, group, kind, row, notes, scavPhase) {
        var suit = {};
        POINT_KEYS.forEach(function (p, i) { suit[p] = row[i]; });
        return { key: key, label: label, group: group, kind: kind, scavPhase: scavPhase || null, suit: suit, notes: notes || {} };
    }
    //                                                                              dh   wh   dsch sepin sepgas flare sepoil sepwat tank
    var FAMILIES = [
        _fam('thi_alcohol', 'Thermodynamic hydrate inhibitor — alcohol', 'hydrate', 'thi', ['A', 'R', 'A', 'N', 'A', 'N', 'X', 'X', 'X'], {
            dh: 'Recommended when the wellbore crosses the hydrate temperature.',
            dsch: 'The choke body and bean are not protected.',
            sepin: 'Too late: the choke outlet is already the coldest point.',
            sepgas: 'Second-expansion point (gas re-expanded at the back-pressure valve).',
            flare: 'Too late for hydrate control.'
        }),
        _fam('thi_glycol', 'Thermodynamic hydrate inhibitor — glycol', 'hydrate', 'thi', ['A', 'R', 'A', 'N', 'N', 'X', 'X', 'X', 'X'], {
            dsch: 'The choke body and bean are not protected.',
            sepin: 'Too late: the choke outlet is already the coldest point.',
            sepgas: 'Liquid carry-over into the gas line.'
        }),
        _fam('ldhi_khi', 'Low-dosage hydrate inhibitor — kinetic', 'hydrate', 'ldhi', ['A', 'R', 'A', 'N', 'X', 'X', 'X', 'X', 'X'], {
            dh: 'Check the cloud point at the downhole temperature.',
            sepin: 'Too late: the choke outlet is already the coldest point.'
        }),
        _fam('ldhi_aa', 'Low-dosage hydrate inhibitor — anti-agglomerant', 'hydrate', 'ldhi', ['A', 'R', 'A', 'N', 'X', 'X', 'X', 'X', 'X'], {
            sepin: 'Too late: the choke outlet is already the coldest point.'
        }),
        _fam('scav_aqueous', 'Aqueous H2S scavenger', 'h2s', 'scavenger', ['N', 'R', 'A', 'A', 'N', 'X', 'N', 'N', 'N'], {
            dh: 'Hydrolysis at temperature and solids downhole.',
            sepin: 'Short contact time to the separator.',
            sepgas: 'Needs a knock-out or contactor downstream; otherwise liquid carries to the flare.',
            sepoil: 'Aqueous product: poor contact with the oil.',
            sepwat: 'Water-phase use is for glyoxal only.',
            tank: 'Not a tank-dosing chemical.'
        }, 'gas'),
        _fam('scav_oil', 'Oil-phase H2S scavenger', 'h2s', 'scavenger', ['X', 'A', 'N', 'N', 'X', 'X', 'R', 'X', 'A'], {
            dsch: 'Oil-phase product: poor contact with the gas.',
            sepin: 'Oil-phase product: poor contact with the gas.'
        }, 'oil'),
        _fam('scav_oxidiser', 'Water-phase oxidiser scavenger', 'h2s', 'scavenger', ['X', 'X', 'X', 'X', 'X', 'X', 'X', 'R', 'N'], {
            tank: 'Oxidiser: O2 or NOx evolution into a hydrocarbon vapour space; dose only into a vented, non-hydrocarbon tank.'
        }, 'water'),
        _fam('ci_oil', 'Corrosion inhibitor — oil-soluble film former', 'corrosion', 'ppm', ['R', 'A', 'A', 'A', 'N', 'X', 'N', 'N', 'N'], {
            sepgas: 'Gas line: use a gas-well (atomised) inhibitor.',
            sepoil: 'Downstream of the equipment it protects.',
            sepwat: 'Downstream of the equipment it protects.',
            tank: 'Downstream of the equipment it protects.'
        }),
        _fam('ci_aqueous', 'Corrosion inhibitor — water-soluble', 'corrosion', 'ppm', ['R', 'A', 'A', 'A', 'X', 'X', 'X', 'A', 'N'], {
            tank: 'Downstream of the equipment it protects.'
        }),
        _fam('ci_gaswell', 'Corrosion inhibitor — gas well (atomised)', 'corrosion', 'ppm', ['A', 'R', 'A', 'N', 'N', 'X', 'X', 'X', 'X'], {
            sepin: 'Downstream of the equipment it protects.',
            sepgas: 'Downstream of the equipment it protects.'
        }),
        _fam('scale', 'Scale inhibitor', 'scale', 'ppm', ['R', 'A', 'A', 'A', 'X', 'X', 'X', 'A', 'N'], {
            dsch: 'Heater-inlet point.',
            tank: 'Downstream of the equipment it protects.'
        }),
        _fam('antifoam', 'Antifoam', 'process', 'ppm', ['X', 'N', 'A', 'R', 'X', 'X', 'N', 'X', 'A'], {
            wh: 'Too early: inject close to the separator, where the foam forms.',
            sepoil: 'After the separator, where the foam forms.'
        }),
        _fam('emulsion', 'Demulsifier', 'process', 'ppm', ['A', 'R', 'A', 'A', 'X', 'X', 'A', 'X', 'A']),
        _fam('clarifier', 'Water clarifier', 'process', 'ppm', ['X', 'N', 'N', 'A', 'X', 'X', 'X', 'R', 'A'], {
            wh: 'Too early: inject where the water is separated.',
            dsch: 'Too early: inject where the water is separated.'
        }),
        _fam('wax', 'Wax inhibitor', 'flow', 'ppm', ['R', 'A', 'A', 'N', 'X', 'X', 'A', 'X', 'A'], {
            dh: 'Inject where the temperature is above the wax appearance temperature.',
            dsch: 'Only if the temperature here is above the wax appearance temperature.',
            sepin: 'Too late: wax has already formed upstream.'
        }),
        _fam('pour_point', 'Pour-point depressant', 'flow', 'ppm', ['N', 'A', 'A', 'N', 'X', 'X', 'R', 'X', 'A'], {
            dh: 'Not a downhole chemical.',
            sepin: 'Inject into the oil leaving the separator.'
        }),
        _fam('asphaltene', 'Asphaltene inhibitor / dispersant', 'flow', 'ppm', ['R', 'A', 'N', 'N', 'X', 'X', 'N', 'X', 'N'], {
            dh: 'Inject below the onset-pressure depth.',
            wh: 'Dispersant only.',
            dsch: 'Downstream of the onset pressure.',
            sepin: 'Downstream of the onset pressure.',
            sepoil: 'Downstream of the onset pressure.',
            tank: 'Downstream of the onset pressure.'
        }),
        _fam('water_systems', 'Water-system chemical', 'water', 'ppm', ['X', 'X', 'X', 'X', 'X', 'X', 'X', 'A', 'A'], {
            sepwat: 'Not normally used in a flowing test.',
            tank: 'Not normally used in a flowing test.'
        }),
        _fam('custom', 'Custom chemical', 'custom', 'custom', ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'], {})
    ];
    var FAM_BY_KEY = {};
    FAMILIES.forEach(function (f) { FAM_BY_KEY[f.key] = f; });

    // ── Dose bases (§4.9) ────────────────────────────────────────────
    // phase: what the dose is referred to. product: the dose is product as supplied.
    // twin / factor: metric twin of a gas or H2S basis (value_twin = value × factor).
    var L_PER_1E6SM3_TO_GAL_PER_MMSCF = 0.028316846592 / 3.785411784;   // 0.0074805
    var BASES = {
        ppmv_oil:        { label: 'ppm by volume on oil / condensate (product, as supplied)', unit: 'ppm v', phase: 'oil', product: true },
        ppmv_water:      { label: 'ppm by volume on water (product, as supplied)', unit: 'ppm v', phase: 'water', product: true },
        ppmv_liq:        { label: 'ppm by volume on total liquid (product, as supplied)', unit: 'ppm v', phase: 'liquid', product: true },
        ppmw_water:      { label: 'ppm by mass on water (product, as supplied)', unit: 'ppm w', phase: 'water', product: true },
        ppmw_oil:        { label: 'ppm by mass on oil / condensate (product, as supplied)', unit: 'ppm w', phase: 'oil', product: true },
        pt_mmscf:        { label: 'US pt of product per MMscf of gas', unit: 'US pt/MMscf', phase: 'gas', product: true, twin: 'l_1e6sm3', factor: (CONSTANTS.usPintML / 1000) / (L_PER_1E6SM3_TO_GAL_PER_MMSCF * CONSTANTS.galToL) },
        gal_mmscf:       { label: 'gal of product per MMscf of gas', unit: 'gal/MMscf', phase: 'gas', product: true, twin: 'l_1e6sm3', factor: 1 / L_PER_1E6SM3_TO_GAL_PER_MMSCF },
        l_1e6sm3:        { label: 'L of product per 10⁶ Sm³ of gas', unit: 'L/10⁶ Sm³', phase: 'gas', product: true, twin: 'gal_mmscf', factor: L_PER_1E6SM3_TO_GAL_PER_MMSCF },
        vol_water:       { label: 'vol % of the water phase (product, as supplied)', unit: 'vol %', phase: 'water', product: true },
        wt_water:        { label: 'wt % in the aqueous phase (from the hydrate design)', unit: 'wt %', phase: 'thi', product: false },
        gal_lb_h2s:      { label: 'gal of product per lb of H2S removed', unit: 'gal/lb', phase: 'h2s', product: true, twin: 'l_kg_h2s', factor: CONSTANTS.galToL / 0.45359237 },
        l_kg_h2s:        { label: 'L of product per kg of H2S removed', unit: 'L/kg', phase: 'h2s', product: true, twin: 'gal_lb_h2s', factor: 0.45359237 / CONSTANTS.galToL },
        ppm_per_ppm_liq: { label: 'ppm of product (mass) per ppm of H2S in the oil', unit: 'ppm/ppm', phase: 'oil', product: true },
        ppm_per_ppm_o2:  { label: 'ppm of product (mass) per ppm of O2 in the water', unit: 'ppm/ppm', phase: 'water', product: true },
        batch_gal:       { label: 'batch volume', unit: 'gal', phase: 'batch', product: true }
    };
    Object.keys(BASES).forEach(function (k) {
        var b = BASES[k]; b.key = k;
        if (!_has(b, 'twin')) b.twin = null;
        if (!_has(b, 'factor')) b.factor = null;
    });

    // ── Chemicals (§5.1) ─────────────────────────────────────────────
    // _chem(key, name, short, family, basis, [dose, min, max], sg, mu68, water, fluidClass, points, extra)
    // effDef null on a stoichiometric scavenger → the point default (points[].etaScav, §3.4).
    function _chem(key, name, short, family, basis, dose, sg, mu68, water, fluid, points, x) {
        var fam = FAM_BY_KEY[family], fc = FLUID[fluid];
        x = x || {};
        var kind = fam.kind;
        var rec = {
            key: key, name: name, short: short, family: family, group: fam.group, kind: kind,
            basis: basis, dose: dose[0], doseMin: dose[1], doseMax: dose[2],
            leanDef: _has(x, 'lean') ? x.lean[0] : null, leanMin: _has(x, 'lean') ? x.lean[1] : null, leanMax: _has(x, 'lean') ? x.lean[2] : null,
            activeDef: _has(x, 'active') ? x.active : null,
            sg: sg, mu68: mu68, muB: _has(x, 'muB') ? x.muB : 2500, water: water,
            fluidClass: fluid, beta: fc.beta, alphaV: fc.alphaV, dPdT: fc.alphaV / fc.beta,
            flashF: _has(x, 'flashF') ? x.flashF : null, freezeF: _has(x, 'freezeF') ? x.freezeF : null,
            flammable: !!x.flammable, oxidiser: !!x.oxidiser, vapourLoss: !!x.vapourLoss, aqueous: water > 0,
            peak: _has(x, 'peak') ? x.peak : (kind === 'thi' ? DEFAULTS.peakThi : kind === 'scavenger' ? DEFAULTS.peakScav : DEFAULTS.peakOther),
            points: points.slice(), suit: x.suit || {},
            incompat: x.tags || [], elastomer: _has(x, 'elastomer') ? x.elastomer : null,
            stoich: x.stoich || null, effDef: _has(x, 'eff') ? x.eff : null,
            thi: x.thi || null, ldhi: x.ldhi || null, freezeCurve: x.freezeCurve || null,
            bestTempF: x.bestTempF || null, muLean: x.muLean || null,
            cautions: x.cautions || '', conf: x.conf || 'M'
        };
        return rec;
    }
    var ORG = 'organic';
    var CHEMICALS = [
        // ── Hydrate inhibitors ──
        _chem('meoh', 'Methanol', 'Methanol', 'thi_alcohol', 'wt_water', [null, null, null], 0.796, 0.58, 0, 'methanol', ['wh', 'dh', 'dsch', 'sepgas'], {
            lean: [100, 90, 100], muB: 1252.7, flashF: 52, freezeF: -144, flammable: true, vapourLoss: true,
            thi: { hamKey: 'methanol', M: 32.04, Mham: 32, K: 2335, nb: true, warnPct: 50, maxPct: 70 },
            freezeCurve: [[0, 32], [20, 5], [30, -15], [40, -38], [50, -65]],
            tags: [ORG, 'methanol', 'alcohol'], elastomer: 'methanol',
            cautions: 'Low flash point and a near-invisible flame; toxic by skin, inhalation and ingestion (exposure limit 200 ppm, skin); high vapour loss; methanol-rich produced water is flammable; can precipitate salt and some scale inhibitors; flooded suction and a shaded tank.',
            conf: 'H'
        }),
        _chem('etoh', 'Ethanol', 'Ethanol', 'thi_alcohol', 'wt_water', [null, null, null], 0.794, 1.2, 0, 'ethanol', ['wh', 'dh', 'dsch'], {
            lean: [95, 90, 100], muB: 1630, flashF: 55, freezeF: -173, flammable: true, vapourLoss: true,
            thi: { hamKey: null, M: 46.07, Mham: 46.07, K: 2335, nb: true, warnPct: 50, maxPct: 70 },
            tags: [ORG, 'alcohol'],
            cautions: 'Flammable; denatured grades may contain methanol; vapour loss uses the methanol correlation (conservative).',
            conf: 'M'
        }),
        _chem('meg', 'Monoethylene glycol (MEG)', 'MEG', 'thi_glycol', 'wt_water', [null, null, null], 1.116, 20, 0, 'glycol', ['wh', 'dh', 'dsch'], {
            lean: [80, 60, 100], muB: 4050, flashF: 232, freezeF: 9,
            thi: { hamKey: 'meg', M: 62.07, Mham: 62, K: 2700, nb: true, warnPct: 60, maxPct: 70 },
            freezeCurve: [[0, 32], [20, 18], [30, 5], [40, -11], [50, -33], [60, -54]],
            muLean: { wtPct: 80, mu68: 9, muB: 3200 },
            tags: [ORG, 'glycol'], elastomer: 'glycol',
            cautions: 'Viscous when cold: size the tubing for the minimum temperature; pure MEG freezes in cold weather; toxic if swallowed.',
            conf: 'H'
        }),
        _chem('deg', 'Diethylene glycol (DEG)', 'DEG', 'thi_glycol', 'wt_water', [null, null, null], 1.118, 36, 0, 'glycol', ['wh', 'dh'], {
            lean: [90, 80, 100], muB: 3700, flashF: 280, freezeF: 14,
            thi: { hamKey: 'deg', M: 106.12, Mham: 106, K: 4000, nb: false, warnPct: 60, maxPct: 70 },
            tags: [ORG, 'glycol'], elastomer: 'glycol',
            cautions: 'Limited validation (Hammerschmidt only); high ingestion toxicity; viscous when cold.',
            conf: 'M'
        }),
        _chem('teg', 'Triethylene glycol (TEG)', 'TEG', 'thi_glycol', 'wt_water', [null, null, null], 1.125, 49, 0, 'glycol', ['wh'], {
            lean: [95, 90, 100], muB: 3700, flashF: 330, freezeF: 19,
            thi: { hamKey: 'teg', M: 150.17, Mham: 150, K: 5400, nb: false, warnPct: 60, maxPct: 70 },
            tags: [ORG, 'glycol'], elastomer: 'glycol',
            cautions: 'A dehydration glycol, rarely injected for hydrate control; limited validation (Hammerschmidt only).',
            conf: 'L'
        }),
        _chem('khi', 'Kinetic hydrate inhibitor (water-soluble polymer in a glycol-ether carrier)', 'KHI', 'ldhi_khi', 'vol_water', [1.5, 0.5, 3], 1.00, 30, 0.30, 'glycol', ['wh', 'dh', 'dsch'], {
            flammable: true,
            ldhi: { subMaxF: 15, subAdvF: 27, needsLHC: false, maxWaterCutPct: null },
            tags: [ORG, 'polymer'], elastomer: 'khi_solvent',
            cautions: 'Subcooling limit applies over the flowing, shut-in and start-up cases; hold time against the planned shut-in; cloud point at hot points; qualify by rocking-cell or autoclave test.',
            conf: 'M'
        }),
        _chem('aa', 'Anti-agglomerant (quaternary-ammonium surfactant type)', 'AA', 'ldhi_aa', 'vol_water', [2.0, 0.5, 3], 0.95, 20, 0.10, 'solvent', ['wh', 'dh', 'dsch'], {
            flammable: true,
            ldhi: { subMaxF: null, subAdvF: null, needsLHC: true, maxWaterCutPct: 50 },
            tags: [ORG, 'surfactant'],
            cautions: 'Needs a liquid hydrocarbon phase and a water cut of 50 % or less; can stabilise emulsions; aquatic toxicity; qualify by test.',
            conf: 'M'
        }),
        // ── H2S scavengers ──
        _chem('h2s_mea_triazine', 'MEA-triazine, 40–50 % aqueous', 'MEA-triazine', 'scav_aqueous', 'gal_lb_h2s', [null, 0.9, 2.2], 1.11, 10, 0.60, 'aqueous', ['wh', 'dsch', 'sepin', 'sepgas'], {
            active: 40, stoich: { mw: 219.28, n: 2, activePct: 40 }, bestTempF: [80, 120],
            tags: [ORG, 'triazine', 'amine', 'aqueous_scavenger'], elastomer: 'triazine',
            cautions: 'Dithiazine solids if over-spent or at low velocity; raises pH and can drop calcium carbonate scale; its water adds to the hydrate load; aquatic toxicity; most effective at moderate temperature.',
            conf: 'H'
        }),
        _chem('h2s_mma_triazine', 'MMA-triazine', 'MMA-triazine', 'scav_aqueous', 'gal_lb_h2s', [null, 0.6, 1.6], 1.03, 5, 0.60, 'aqueous', ['wh', 'dsch', 'sepin', 'sepoil'], {
            active: 40, stoich: { mw: 129.21, n: 2, activePct: 40 }, eff: 0.55,
            suit: { sepoil: 'A' },
            tags: [ORG, 'triazine', 'amine', 'aqueous_scavenger'], elastomer: 'triazine',
            cautions: 'More volatile and more hydrolysis-resistant than MEA-triazine; use the supplier figure for the ratio.',
            conf: 'L'
        }),
        _chem('h2s_glyoxal', 'Glyoxal 40 %', 'Glyoxal', 'scav_aqueous', 'gal_lb_h2s', [null, 0.5, 2.5], 1.27, 10, 0.60, 'aqueous', ['wh', 'sepin', 'sepwat', 'sepoil'], {
            active: 40, stoich: { mw: 58.04, n: 1, activePct: 40 }, eff: 0.40,
            suit: { sepwat: 'A' },
            tags: [ORG, 'aldehyde', 'glyoxal', 'acidic', 'aqueous_scavenger'],
            cautions: 'Acidic (pH 2–3.5): stainless wetted parts and a corrosion inhibitor; slow reaction; does not raise scale; one H2S per molecule assumed.',
            conf: 'L'
        }),
        _chem('h2s_aldehyde_blend', 'Formaldehyde-releaser blend (hemiformal / oxazolidine)', 'Aldehyde-releaser blend', 'scav_aqueous', 'gal_lb_h2s', [1.2, 0.6, 2.0], 1.10, 10, 0.50, 'aqueous', ['wh', 'dsch', 'sepin', 'sepoil'], {
            tags: [ORG, 'aldehyde', 'aqueous_scavenger'],
            cautions: 'Formaldehyde exposure hazard; use the supplier figure for the ratio.',
            conf: 'L'
        }),
        _chem('h2s_oil_soluble', 'Oil-soluble amine-aldehyde scavenger', 'Oil-soluble scavenger', 'scav_oil', 'ppm_per_ppm_liq', [8, 3, 20], 0.95, 20, 0, 'solvent', ['sepoil', 'tank', 'wh'], {
            flammable: true,
            tags: [ORG, 'amine'],
            cautions: 'For H2S in crude or condensate; use the supplier figure for the ratio.',
            conf: 'L'
        }),
        _chem('h2s_zinc', 'Zinc carboxylate (oil-soluble)', 'Zinc carboxylate', 'scav_oil', 'gal_lb_h2s', [1.9, 1.6, 3.0], 1.00, 30, 0, 'solvent', ['sepoil', 'tank', 'wh'], {
            flammable: true,
            tags: [ORG, 'zinc'],
            cautions: 'Zinc sulfide fines stabilise emulsions; check the discharge limits for zinc.',
            conf: 'M'
        }),
        _chem('h2s_nitrite', 'Sodium nitrite 30 %', 'Sodium nitrite', 'scav_oxidiser', 'gal_lb_h2s', [0.4, 0.25, 0.8], 1.20, 2, 0.70, 'aqueous', ['sepwat'], {
            active: 30, oxidiser: true,
            tags: ['oxidiser', 'nitrite'],
            cautions: 'Oxidiser: never with organics or amines; with acidic sour water it can release NOx (keep pH above about 7 and ventilate); sulfur deposits; never block in the line.',
            conf: 'L–M'
        }),
        _chem('h2s_peroxide', 'Hydrogen peroxide 35 %', 'Hydrogen peroxide', 'scav_oxidiser', 'gal_lb_h2s', [0.4, 0.3, 1.4], 1.13, 1.1, 0.65, 'aqueous', ['sepwat'], {
            active: 35, oxidiser: true,
            tags: ['oxidiser', 'peroxide'],
            cautions: 'Strong oxidiser: decomposes to O2 (flammable atmosphere in a hydrocarbon vapour space; overpressure when blocked in); vented, non-hydrocarbon tank only; water phase only.',
            conf: 'M'
        }),
        // ── Corrosion inhibitors ──
        _chem('ci_film_liq', 'Film-forming corrosion inhibitor (imidazoline / fatty amine / quaternary in solvent)', 'Film-forming corrosion inhibitor', 'ci_oil', 'ppmv_liq', [25, 10, 100], 0.92, 20, 0, 'solvent', ['dh', 'wh', 'dsch', 'sepin'], {
            active: 30, flammable: true,
            tags: [ORG, 'corrosion_inhibitor', 'cationic', 'amine'], elastomer: 'ci_solvent',
            cautions: 'Overdose gives emulsion and foam; a cationic inhibitor and an anionic scale inhibitor precipitate when mixed neat; flammable solvent.',
            conf: 'M'
        }),
        _chem('ci_water', 'Water-soluble corrosion inhibitor', 'Water-soluble corrosion inhibitor', 'ci_aqueous', 'ppmv_water', [50, 20, 200], 1.03, 10, 0.60, 'aqueous', ['dh', 'wh', 'sepin'], {
            active: 30,
            tags: [ORG, 'corrosion_inhibitor'],
            cautions: 'Check compatibility with the other chemicals and the produced water.',
            conf: 'M'
        }),
        _chem('ci_gas', 'Gas-well corrosion inhibitor (atomised)', 'Gas-well corrosion inhibitor', 'ci_gaswell', 'pt_mmscf', [1.0, 0.25, 2], 0.92, 20, 0, 'solvent', ['wh', 'dh', 'dsch'], {
            active: 30, flammable: true,
            tags: [ORG, 'corrosion_inhibitor'], elastomer: 'ci_solvent',
            cautions: 'Atomise into the gas; batch treatments per the supplier procedure.',
            conf: 'L–M'
        }),
        // ── Scale inhibitors ──
        _chem('si_phosphonate', 'Phosphonate scale inhibitor', 'Phosphonate scale inhibitor', 'scale', 'ppmw_water', [10, 2, 50], 1.20, 10, 0.60, 'aqueous', ['dh', 'wh', 'dsch', 'sepin'], {
            active: 30,
            tags: [ORG, 'scale_inhibitor', 'anionic', 'acidic_si'], elastomer: 'si_acidic',
            cautions: 'Dose 1.5–2 times the minimum inhibitor concentration (quoted as ppm active); high calcium can drop calcium phosphonate; high methanol can precipitate the inhibitor; acidic forms pH 1–3.',
            conf: 'M'
        }),
        _chem('si_polymer', 'Polymeric scale inhibitor', 'Polymeric scale inhibitor', 'scale', 'ppmw_water', [15, 5, 50], 1.15, 15, 0.60, 'aqueous', ['dh', 'wh', 'dsch'], {
            active: 30,
            tags: [ORG, 'scale_inhibitor', 'anionic', 'polymer'], elastomer: 'si_acidic',
            cautions: 'For sulfate scales; more tolerant of MEG than phosphonates.',
            conf: 'M'
        }),
        // ── Foam and emulsion ──
        _chem('af_silicone', 'Silicone antifoam (PDMS in solvent)', 'Silicone antifoam', 'antifoam', 'ppmv_oil', [5, 1, 30], 0.95, 50, 0, 'solvent', ['sepin', 'dsch'], {
            active: 30, flammable: true,
            tags: [ORG, 'antifoam', 'silicone'],
            cautions: 'Silicon poisons refinery catalysts: check the buyer\'s silicon limit; tiny rates, so dilute.',
            conf: 'M'
        }),
        _chem('af_nonsilicone', 'Non-silicone antifoam (polyglycol / alcohol)', 'Non-silicone antifoam', 'antifoam', 'ppmv_oil', [20, 5, 100], 0.98, 30, 0, 'solvent', ['sepin', 'dsch'], {
            active: 30, flammable: true,
            tags: [ORG, 'antifoam'],
            cautions: 'Overdose stabilises foam.',
            conf: 'M'
        }),
        _chem('demulsifier', 'Demulsifier (oxyalkylated resin / polyol blend in aromatic solvent)', 'Demulsifier', 'emulsion', 'ppmv_oil', [30, 5, 200], 0.94, 30, 0, 'solvent', ['wh', 'dh', 'dsch', 'sepin'], {
            active: 30, flammable: true,
            tags: [ORG, 'demulsifier'],
            cautions: 'Select by bottle test; overdose re-stabilises the emulsion; the solvent often has a low flash point.',
            conf: 'M'
        }),
        _chem('water_clarifier', 'Water clarifier (cationic polymer)', 'Water clarifier', 'clarifier', 'ppmv_water', [10, 2, 50], 1.05, 50, 0.60, 'aqueous', ['sepwat', 'sepin'], {
            active: 30,
            tags: [ORG, 'cationic', 'polymer'],
            cautions: 'Only where the water is discharged or reinjected.',
            conf: 'M'
        }),
        // ── Wax and asphaltene ──
        _chem('paraffin_inhibitor', 'Wax inhibitor (EVA / polyacrylate comb polymer)', 'Wax inhibitor', 'wax', 'ppmv_oil', [200, 50, 1000], 0.90, 50, 0, 'solvent', ['dh', 'wh', 'dsch'], {
            active: 30, flammable: true,
            tags: [ORG, 'polymer'],
            cautions: 'Inject where the temperature is above the wax appearance temperature, with margin; check the product pour point (winterised grade in cold weather).',
            conf: 'M'
        }),
        _chem('ppd', 'Pour-point depressant', 'Pour-point depressant', 'pour_point', 'ppmv_oil', [300, 100, 2000], 0.90, 50, 0, 'solvent', ['sepoil', 'wh', 'dsch'], {
            active: 30, flammable: true,
            tags: [ORG, 'polymer'],
            cautions: 'Check the product pour point (winterised grade in cold weather).',
            conf: 'M'
        }),
        _chem('asphaltene_inhibitor', 'Asphaltene inhibitor / dispersant (alkylphenol resin / polyisobutylene succinimide)', 'Asphaltene inhibitor', 'asphaltene', 'ppmv_oil', [200, 50, 1000], 0.92, 20, 0, 'solvent', ['dh', 'wh'], {
            active: 30, flammable: true,
            tags: [ORG],
            cautions: 'Inject below the onset-pressure depth; qualify on live oil.',
            conf: 'M'
        }),
        // ── Water systems ──
        _chem('biocide', 'Biocide (glutaraldehyde / THPS / quaternary)', 'Biocide', 'water_systems', 'ppmv_water', [250, 50, 1000], 1.10, 5, 0.50, 'aqueous', ['sepwat', 'tank'], {
            active: 30,
            tags: [ORG, 'aldehyde', 'biocide'],
            cautions: 'Not normally used in a flowing test; batch dose.',
            conf: 'M'
        }),
        _chem('o2_scavenger', 'Ammonium bisulfite 65 %', 'Ammonium bisulfite', 'water_systems', 'ppm_per_ppm_o2', [10, 8, 15], 1.35, 5, 0.35, 'aqueous', ['tank', 'sepwat'], {
            active: 65,
            tags: ['bisulfite', 'reducer'],
            cautions: 'Not normally used in a flowing test; never with aldehydes.',
            conf: 'M'
        }),
        // ── Custom ──
        _chem('custom', 'Custom chemical', 'Custom chemical', 'custom', 'ppmv_liq', [null, null, null], 1.00, 10, 0, 'solvent', POINT_KEYS, {
            tags: [],
            cautions: 'Enter the data-sheet values (dose basis, dose, SG, viscosity, water content).',
            conf: 'L'
        })
    ];
    var CHEM_BY_KEY = {};
    CHEMICALS.forEach(function (c) { CHEM_BY_KEY[c.key] = c; });

    // ── Injection points (§3.1, §3.4) ────────────────────────────────
    function _pt(key, order, branch, label, short, pLine, pBack, pBackClass, tBasis, ph, wellbore, upstream, segs, segsHeater, eta, pumpClass, note) {
        return {
            key: key, order: order, branch: branch, label: label, short: short,
            pLine: pLine, pBack: pBack, pBackClass: pBackClass, tBasis: tBasis,
            phases: { gas: ph.indexOf('g') !== -1, water: ph.indexOf('w') !== -1, oil: ph.indexOf('o') !== -1 },
            wellbore: wellbore, upstreamOfSep: upstream, contactSegs: segs, contactSegsHeater: segsHeater,
            etaScav: eta, pumpClass: pumpClass, note: note || ''
        };
    }
    var POINTS = [
        _pt('dh', 0, 'well', 'Downhole — CIV / capillary / subsea-test-tree port', 'Downhole', 'dh', 'sithp', 'whclass', 'dh', 'gwo', true, true, [1, 2, 3, 4], [1, 2, 3, 4], null,
            'High-pressure plunger (small plunger), air-driven liquid pump or skid',
            'Pressure at depth from the tubing; contact also includes the tubing above the injection depth.'),
        _pt('wh', 1, 'well', 'Flowhead / upstream of choke (upstream data header)', 'Upstream of choke', 'wh', 'sithp', 'whclass', 'fwht', 'gwo', true, true, [1, 2, 3, 4], [1, 2, 3, 4], 0.58,
            'Air-driven liquid pump, high-pressure plunger or skid',
            'Required pressure from the shut-in case: max(SITHP, FWHP).'),
        _pt('dsch', 2, 'well', 'Downstream of choke / heater inlet', 'Downstream of choke', 'ck', 'psvsep', 'psvsep', 'ck', 'gwo', false, true, [2, 3, 4], [2, 3, 4], 0.50,
            'Pneumatic plunger or hydraulic-diaphragm metering pump',
            'A blocked separator lets this section rise to the separator relief-valve set pressure.'),
        _pt('sepin', 3, 'well', 'Heater outlet / separator inlet', 'Separator inlet', 'sep', 'psvsep', 'psvsep', 'htr', 'gwo', false, true, [3, 4], [4], 0.45,
            'Pneumatic plunger or diaphragm metering pump',
            'Temperature is the heater outlet when the heater is on, else the choke outlet.'),
        _pt('sepgas', 4, 'gas', 'Separator gas outlet (upstream of back-pressure valve / meter)', 'Separator gas outlet', 'sep', 'psvsep', 'psvsep', 'sep', 'g', false, false, [], [], 0.40,
            'Diaphragm metering pump or pneumatic plunger',
            'Saturated gas with carried mist; the gas re-expands across the back-pressure valve.'),
        _pt('flare', 5, 'gas', 'Flare / sales line downstream of the back-pressure valve', 'Flare line', 'bpv', 'psvsep', 'psvsep', 'bpv', 'g', false, false, [], [], null,
            'Low-pressure metering pump',
            'Back-pressure basis: a failed-open back-pressure valve.'),
        _pt('sepoil', 4, 'oil', 'Separator oil outlet (upstream of level valve)', 'Separator oil outlet', 'sep', 'psvsep', 'psvsep', 'sep', 'o', false, false, [], [], null,
            'Diaphragm metering pump rated above the separator pressure plus allowance',
            ''),
        _pt('sepwat', 4, 'water', 'Separator water outlet', 'Separator water outlet', 'sep', 'psvsep', 'psvsep', 'sep', 'w', false, false, [], [], null,
            'Diaphragm metering pump rated above the separator pressure plus allowance',
            ''),
        _pt('tank', 5, 'liquid', 'Surge / gauge tank', 'Tank', 'atm', 'none', 'none', 'sep', 'wo', false, false, [], [], null,
            'Solenoid or mechanical diaphragm pump, air-operated diaphragm pump',
            'Fit an anti-siphon / back-pressure valve when the injection pressure is below the chemical-tank head.')
    ];
    var PT_BY_KEY = {};
    POINTS.forEach(function (p) { PT_BY_KEY[p.key] = p; });

    // ── Plunger, stroke and actuator lists (§2.3) ────────────────────
    var PLUNGERS = [0.1875, 0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.25].map(_size);
    var STROKES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(_size);
    var ACTUATORS = [4, 6, 8].map(_size);

    // ── Pumps (§5.2) — generic, illustrative envelopes ───────────────
    function _pump(o) {
        var base = {
            key: '', name: '', short: '', kind: '', setting: '', mvp: true, electric: false, vents: false,
            hazSuitable: true, hazAreaNote: '',
            plungers: null, plungerDef: null, strokes: null, strokeDef: null, strokeMax: null, headsMax: 1,
            actuators: null, actDef: null,
            spmMax: null, spmMin: null, spmCrank: null, spmCrankMin: null, spmCrankMax: null,
            sMin: null, nMin: null, vfd: false,
            pmaxRule: 'fixed', bodyPsi: null, pmax: null, rodLbf: null, capPsi: null, etaM: null, pSpring: null,
            qRated_galh: null, q0_galh: null, ratio: null, vcyc_in3: null, stallFracMax: null, q0FracMin: null,
            etaDef: null, accuracy: '', turndown: '', bestPoints: [], conf: 'M'
        };
        for (var k in o) if (_has(o, k)) base[k] = o[k];
        return base;
    }
    var PUMPS = [
        _pump({
            key: 'pneu_plunger', name: 'Pneumatic plunger pump (gas or air actuator, single-acting; 1 or 2 plungers on one actuator)',
            short: 'Pneumatic plunger', kind: 'plunger', setting: 'spm', vents: true,
            hazAreaNote: 'Suitable in a classified area (no electrics); vents its drive gas at the pump.',
            plungers: [0.1875, 0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1], plungerDef: 0.5,
            strokes: [0.25, 0.5, 0.75, 1], strokeDef: 1, strokeMax: 1, headsMax: 2,
            actuators: [4, 6, 8], actDef: 4, spmMax: 60, spmMin: 3,
            pmaxRule: 'pneumatic', bodyPsi: 10000, etaM: 0.8, pSpring: 5, etaDef: 0.90,
            accuracy: '±5–10 % uncalibrated, ±2–5 % after a drawdown calibration',
            turndown: 'about 10–20:1 on speed × 3:1 on stroke; some families run at 25–30 SPM maximum (edit)',
            bestPoints: ['wh', 'dsch', 'sepin', 'dh'], conf: 'M'
        }),
        _pump({
            key: 'air_liquid', name: 'Air-driven liquid pump (pressure amplifier)', short: 'Air-driven liquid pump',
            kind: 'airliquid', setting: 'air', vents: true,
            hazAreaNote: 'Suitable in a classified area (no electrics); vents its drive gas at the pump.',
            pmaxRule: 'ratio', bodyPsi: 10000, q0_galh: 30, ratio: 100, vcyc_in3: 1.0,
            stallFracMax: 0.7, q0FracMin: 0.1,
            accuracy: 'Not a metering pump: set the air and verify the rate with a drawdown cylinder or meter (mandatory)',
            turndown: 'design flow at least 0.1 × free flow; operate at or below 0.7 × stall pressure',
            bestPoints: ['wh', 'dh'], conf: 'M'
        }),
        _pump({
            key: 'elec_plunger', name: 'Electric packed-plunger metering pump (API 675 class)', short: 'Electric plunger metering pump',
            kind: 'plunger', setting: 'stroke_speed', electric: true, hazSuitable: false,
            hazAreaNote: 'Electric pump: the motor and controls must be certified for the zone.',
            plungers: [0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.25], plungerDef: 0.875,
            strokes: [0.25, 0.5, 0.75, 1], strokeDef: 1, strokeMax: 1, headsMax: 3,
            spmMax: 120, spmCrank: 120, spmCrankMin: 30, spmCrankMax: 180, sMin: 10, nMin: 10, vfd: false,
            pmaxRule: 'rod', rodLbf: 2500, capPsi: 15000, etaDef: 0.90,
            accuracy: '±1 % over 10:1 (API 675)', turndown: '10:1 on stroke (× speed with a variable-speed drive)',
            bestPoints: ['wh', 'dh'], conf: 'M'
        }),
        _pump({
            key: 'elec_hyd_diaph', name: 'Hydraulically-actuated diaphragm metering pump (API 675 class)', short: 'Hydraulic-diaphragm metering pump',
            kind: 'meter', setting: 'stroke_speed', electric: true, hazSuitable: false,
            hazAreaNote: 'Electric pump: the motor and controls must be certified for the zone.',
            qRated_galh: 5, spmMax: 120, sMin: 10, nMin: 10, vfd: true, pmaxRule: 'fixed', pmax: 3000,
            accuracy: '±1 % over 10:1 (API 675)', turndown: '10:1 on stroke × speed',
            bestPoints: ['dsch', 'sepin', 'wh'], conf: 'M'
        }),
        _pump({
            key: 'elec_solenoid', name: 'Electric solenoid diaphragm metering pump', short: 'Solenoid metering pump',
            kind: 'meter', setting: 'stroke_speed', electric: true, hazSuitable: false,
            hazAreaNote: 'Electric pump: the unit must be certified for the zone.',
            qRated_galh: 10 / CONSTANTS.galToL, spmMax: 120, sMin: 20, nMin: 10, vfd: true, pmaxRule: 'fixed', pmax: 150,
            accuracy: '±2 % repeatability', turndown: 'about 100:1 on stroke × pulse rate',
            bestPoints: ['tank', 'sepoil', 'sepwat'], conf: 'M'
        }),
        _pump({
            key: 'elec_mech_diaph', name: 'Motor-driven mechanical diaphragm metering pump', short: 'Mechanical-diaphragm metering pump',
            kind: 'meter', setting: 'stroke_speed', electric: true, hazSuitable: false,
            hazAreaNote: 'Electric pump: the motor and controls must be certified for the zone.',
            qRated_galh: 20, spmMax: 180, spmMin: 30, sMin: 20, nMin: 10, vfd: true, pmaxRule: 'fixed', pmax: 250,
            accuracy: 'about ±2–5 %', turndown: '10:1 on stroke',
            bestPoints: ['tank', 'sepoil', 'sepwat'], conf: 'M–L'
        }),
        _pump({
            key: 'air_diaph', name: 'Air-operated diaphragm transfer pump', short: 'Air-operated diaphragm pump',
            kind: 'transfer', setting: 'cycles', vents: true,
            hazAreaNote: 'Suitable in a classified area (no electrics); vents its drive gas at the pump.',
            q0_galh: 300, ratio: 1, spmMax: 200, pmaxRule: 'ratio',
            accuracy: 'coarse: transfer duty, not metering', turndown: 'coarse',
            bestPoints: ['tank'], conf: 'M–L'
        }),
        _pump({
            key: 'hand', name: 'Hand pump (batch)', short: 'Hand pump', kind: 'hand', setting: 'batch', mvp: false,
            hazAreaNote: 'Suitable in a classified area.',
            vcyc_in3: 1.0, pmaxRule: 'fixed', pmax: 10000,
            accuracy: 'batch only', turndown: 'batch only',
            bestPoints: ['wh'], conf: 'L'
        })
    ];
    var PUMP_BY_KEY = {};
    PUMPS.forEach(function (p) { PUMP_BY_KEY[p.key] = p; });

    // ── Capillary / control lines (§5.3) — Barlow, 316 stainless at 20 ksi ──
    var CAPILLARY = [['c250_035', 0.25, 0.035], ['c250_049', 0.25, 0.049], ['c375_049', 0.375, 0.049], ['c375_065', 0.375, 0.065]].map(function (r) {
        var id = _r(r[1] - 2 * r[2], 3), idMm = _r(id * 25.4, 2);
        return {
            key: r[0], od: r[1], wall: r[2], id: id, idMm: idMm,
            barlowPsi: Math.round(2 * 20000 * r[2] / r[1] / 10) * 10,
            label: _frac(r[1]) + ' × ' + r[2].toFixed(3) + ' in capillary (ID ' + idMm.toFixed(2) + ' mm)'
        };
    });
    var CAP_BY_KEY = {};
    CAPILLARY.forEach(function (c) { CAP_BY_KEY[c.key] = c; });

    // ── Compatibility rules (§5.4) ───────────────────────────────────
    // Pair rule: a chemical carrying any tag of a[] and another carrying any tag of b[]
    // (either order). Context rule: one chemical carrying a tag of a[] in the context ctx:
    //   'hc_tank' hydrocarbon tank or vapour space · 'sepgas_no_ko' at the separator gas outlet
    //   with no knock-out · 'ca_water' produced water with calcium / bicarbonate ·
    //   'sale_crude' crude for sale · 'carbon_steel' carbon-steel wetted parts.
    var COMPAT = [
        { key: 'organic_oxidiser', a: ['organic'], b: ['oxidiser'], ctx: null, level: 'bad', text: 'Never in the same line or tank: violent reaction, and the chemical is destroyed.' },
        { key: 'oxidiser_hc_tank', a: ['oxidiser'], b: null, ctx: 'hc_tank', level: 'warn', text: 'O2 or NOx evolution into a hydrocarbon vapour space: vented, non-hydrocarbon tank only.' },
        { key: 'amine_nitrite', a: ['triazine', 'amine'], b: ['nitrite'], ctx: null, level: 'bad', text: 'Never together: possible nitrosamines, and the nitrite is consumed.' },
        { key: 'aldehyde_bisulfite', a: ['aldehyde'], b: ['bisulfite'], ctx: null, level: 'bad', text: 'Do not dose together: bisulfite adducts deactivate both.' },
        { key: 'triazine_aldehyde', a: ['triazine'], b: ['aldehyde'], ctx: null, level: 'warn', text: 'Use separate injection points.' },
        { key: 'triazine_acidic_si', a: ['triazine'], b: ['acidic_si'], ctx: null, level: 'warn', text: 'Use separate lines: neat mixing precipitates.' },
        { key: 'cationic_anionic', a: ['cationic'], b: ['anionic'], ctx: null, level: 'warn', text: 'Separate quills several pipe diameters apart.' },
        { key: 'methanol_si', a: ['methanol'], b: ['scale_inhibitor'], ctx: null, level: 'warn', text: 'Inhibitor salts may precipitate in high-methanol water: test compatibility (MEG is milder).' },
        { key: 'ci_antifoam', a: ['corrosion_inhibitor', 'demulsifier'], b: ['antifoam'], ctx: null, level: 'warn', text: 'Bottle-test the package: an overdose reverses the effect.' },
        { key: 'triazine_ca_water', a: ['triazine'], b: null, ctx: 'ca_water', level: 'warn', text: 'Calcium carbonate scale and emulsions: add a scale inhibitor and avoid overdosing.' },
        { key: 'silicone_sale_crude', a: ['silicone'], b: null, ctx: 'sale_crude', level: 'warn', text: 'Check the buyer\'s silicon limit for the crude.' },
        { key: 'glyoxal_carbon_steel', a: ['glyoxal'], b: null, ctx: 'carbon_steel', level: 'warn', text: 'Use stainless wetted parts and a corrosion inhibitor.' },
        { key: 'aq_scav_sepgas', a: ['aqueous_scavenger'], b: null, ctx: 'sepgas_no_ko', level: 'warn', text: 'Liquid carry-over to the flare: fit a knock-out or contactor downstream.' }
    ];

    // ── Elastomer screening (§5.5): A good, B fair, C poor ───────────
    var MATERIALS = ['NBR', 'HNBR', 'EPDM', 'FKM std', 'FKM peroxide', 'FFKM', 'PTFE'];
    function _el(label, v) { var o = { label: label }; MATERIALS.forEach(function (m, i) { o[m] = v[i]; }); return o; }
    var ELASTOMER = {
        materials: MATERIALS,
        rows: {
            methanol:    _el('Methanol', ['B', 'B', 'A', 'C', 'A-B', 'A', 'A']),
            glycol:      _el('MEG / glycols', ['A', 'A', 'A', 'A', 'A', 'A', 'A']),
            triazine:    _el('MEA-triazine', ['B', 'B', 'A', 'C', 'B-C', 'A', 'A']),
            ci_solvent:  _el('Oil-soluble corrosion inhibitor (aromatic solvent)', ['B', 'B', 'C', 'A', 'A', 'A', 'A']),
            si_acidic:   _el('Aqueous acidic scale inhibitor', ['A-B', 'A', 'A', 'A-B', 'A', 'A', 'A']),
            khi_solvent: _el('KHI in glycol-ether solvent', ['B-C', 'B', 'A-B', 'C', 'B', 'A', 'A'])
        },
        note: 'Seals: avoid standard FKM with methanol; use rapid-gas-decompression-rated grades in gas service above about 1000 psi.'
    };

    // ── Lookups ──────────────────────────────────────────────────────
    function find(key) { return _has(CHEM_BY_KEY, key) ? CHEM_BY_KEY[key] : null; }
    function suit(chemKey, pointKey) {
        var c = find(chemKey);
        if (!c || !_has(PT_BY_KEY, pointKey)) return null;
        if (_has(c.suit, pointKey)) return c.suit[pointKey];
        var f = FAM_BY_KEY[c.family];
        return f ? f.suit[pointKey] : null;
    }
    function suitInfo(chemKey, pointKey) {
        var lv = suit(chemKey, pointKey);
        if (!lv) return null;
        var c = find(chemKey), f = FAM_BY_KEY[c.family];
        var note = (_has(c.suit, pointKey)) ? '' : ((f && f.notes[pointKey]) || '');
        if (!note) note = lv === 'X' ? X_NOTE : lv === 'N' ? 'Not recommended at this point.' : lv === 'R' ? 'Recommended point.' : 'Allowed point.';
        return { level: lv, verdict: lv === 'X' ? 'bad' : lv === 'N' ? 'warn' : 'ok', note: note };
    }
    function _tagHit(tags, list) { if (!list) return false; for (var i = 0; i < list.length; i++) if (tags.indexOf(list[i]) !== -1) return true; return false; }
    function pairRules(ka, kb) {
        var a = find(ka), b = find(kb);
        if (!a || !b) return [];
        return COMPAT.filter(function (r) {
            return r.b && ((_tagHit(a.incompat, r.a) && _tagHit(b.incompat, r.b)) || (_tagHit(b.incompat, r.a) && _tagHit(a.incompat, r.b)));
        });
    }
    function ctxRules(k) {
        var c = find(k);
        if (!c) return [];
        return COMPAT.filter(function (r) { return r.ctx && _tagHit(c.incompat, r.a); });
    }

    G.WTS_chemlib = {
        version: 1,
        groups: GROUPS,
        families: FAMILIES,
        chemicals: CHEMICALS,
        bases: BASES,
        points: POINTS,
        pointKeys: POINT_KEYS.slice(),
        pumps: PUMPS,
        plungers: PLUNGERS,
        strokes: STROKES,
        actuators: ACTUATORS,
        heads: [1, 2, 3],
        capillary: CAPILLARY,
        compat: COMPAT,
        elastomer: ELASTOMER,
        fluidClasses: FLUID,
        constants: CONSTANTS,
        defaults: DEFAULTS,
        find: find,
        list: function (x) {
            if (x == null || x === '') return CHEMICALS.slice();
            return CHEMICALS.filter(function (c) { return c.family === x || c.group === x; });
        },
        family: function (k) { return _has(FAM_BY_KEY, k) ? FAM_BY_KEY[k] : null; },
        point: function (k) { return _has(PT_BY_KEY, k) ? PT_BY_KEY[k] : null; },
        pump: function (k) { return _has(PUMP_BY_KEY, k) ? PUMP_BY_KEY[k] : null; },
        cap: function (k) { return _has(CAP_BY_KEY, k) ? CAP_BY_KEY[k] : null; },
        suit: suit,
        suitInfo: suitInfo,
        eff: function (chemKey, pointKey) {
            var c = find(chemKey);
            if (!c || c.kind !== 'scavenger' || !c.stoich) return null;
            if (c.effDef != null) return c.effDef;
            var p = _has(PT_BY_KEY, pointKey) ? PT_BY_KEY[pointKey] : null;
            return p && p.etaScav != null ? p.etaScav : null;
        },
        pairRules: pairRules,
        ctxRules: ctxRules,
        elastomerRow: function (k) { var c = find(k); return c && c.elastomer && _has(ELASTOMER.rows, c.elastomer) ? ELASTOMER.rows[c.elastomer] : null; }
    };
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var C = G.WTS_chemlib, fails = [];
    function ok(c, what) { if (!c) fails.push(what); }
    function near(a, b, tol, what) { if (!(Math.abs(a - b) <= tol)) fails.push(what + ': ' + a + ' vs ' + b); }
    ok(C && C.chemicals.length === 30 && C.points.length === 9 && C.pumps.length === 8, 'record counts');
    C.chemicals.forEach(function (c) {
        ok(C.family(c.family) && C.bases[c.basis], c.key + ' family / basis');
        ok(typeof c.sg === 'number' && c.sg > 0.5 && c.sg < 2 && c.water >= 0 && c.water < 1, c.key + ' sg / water');
        c.points.forEach(function (p) { ok(C.suit(c.key, p) && C.suit(c.key, p) !== 'X', c.key + ' ranked point ' + p); });
        ok(c.cautions.length < 299, c.key + ' cautions length');
    });
    near(C.find('meoh').dPdT, 76.74, 0.05, 'methanol blocked-in psi/°F');
    near(C.cap('c250_049').barlowPsi, 7840, 0, 'capillary Barlow');
    near(C.eff('h2s_mea_triazine', 'wh'), 0.58, 1e-12, 'MEA-triazine η at wh');
    ok(C.suit('h2s_nitrite', 'wh') === 'X' && C.suit('h2s_mma_triazine', 'sepoil') === 'A', 'suitability overrides');
    ok(C.pairRules('h2s_nitrite', 'h2s_mea_triazine').some(function (r) { return r.level === 'bad'; }), 'nitrite + triazine rule');
    if (fails.length && typeof console !== 'undefined') console.error('[chemlib self-test] FAILED:\n  ' + fails.join('\n  '));
})();
