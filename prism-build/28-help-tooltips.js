// ════════════════════════════════════════════════════════════════════
// WTS — Layer 28 — Help Tooltips (in-line input guidance)
//
// PURPOSE
//   Adds a small "ⓘ" hover hint after every tagged input field in the
//   suite. On hover (or focus / click) a dark-themed tooltip shows a
//   one-line description, typical range, units and (optionally) a
//   reference. The system is data-driven: features add entries through
//   `WTS_helpTooltips.define(id, meta)` and the manager handles DOM
//   injection, positioning, lifecycle and event listeners.
//
// PUBLIC API (all on window.*)
//   window.WTS_helpTooltips = {
//       define(inputId, { description, typicalRange, units, references? }),
//       defineMany(manifestObject),
//       refresh(),       // re-scan DOM and inject ⓘ icons for tagged inputs
//       show(inputId),   // programmatic show
//       hide(),
//       list()           // returns array of registered ids (for QA)
//   }
//
//   window.WTS_renderHelpTooltipsManager(container)
//       — optional admin UI listing every registered tooltip
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'
//   • No external runtime deps — vanilla JS, Math.*
//   • Pure CSS-in-JS, dark theme, literal hex colours
//   • Defensive — never throws when DOM is missing (smoke-test friendly)
//   • Idempotent — calling refresh() multiple times never duplicates icons
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    // ───────────────────────────────────────────────────────────────
    // Tiny env helpers
    // ───────────────────────────────────────────────────────────────
    function _log() {
        if (typeof console !== 'undefined' && console.log) {
            try { console.log.apply(console, arguments); } catch (e) {}
        }
    }
    function _warn() {
        if (typeof console !== 'undefined' && console.warn) {
            try { console.warn.apply(console, arguments); } catch (e) {}
        }
    }
    function _err() {
        if (typeof console !== 'undefined' && console.error) {
            try { console.error.apply(console, arguments); } catch (e) {}
        }
    }
    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function _$(id) {
        if (!_hasDoc) return null;
        return document.getElementById(id);
    }

    // ───────────────────────────────────────────────────────────────
    // Registry — tooltip metadata, keyed by input id
    //   id → { description, typicalRange, units, references }
    // ───────────────────────────────────────────────────────────────
    var REGISTRY = {};

    function define(inputId, meta) {
        if (!inputId || typeof inputId !== 'string') return false;
        meta = meta || {};
        REGISTRY[inputId] = {
            title:        String(meta.title || ''),
            description:  String(meta.description || ''),
            typicalRange: String(meta.typicalRange || ''),
            units:        String(meta.units || ''),
            references:   Array.isArray(meta.references) ? meta.references.slice() : []
        };
        return true;
    }

    // Plain-language heading for a tooltip: the entry's title, else the id
    // turned into words ("prism_well_pi" → "Well pi").
    function _titleFor(id) {
        var m = REGISTRY[id];
        if (m && m.title) return m.title;
        var s = String(id || '').replace(/^(PRiSM|prism|wts)_+/i, '').replace(/^(help|well|sl|match|reg)_+/i, '')
            .replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Help';
    }

    function defineMany(manifest) {
        if (!manifest || typeof manifest !== 'object') return 0;
        var count = 0;
        for (var k in manifest) {
            if (Object.prototype.hasOwnProperty.call(manifest, k)) {
                if (define(k, manifest[k])) count++;
            }
        }
        return count;
    }

    function list() {
        var out = [];
        for (var k in REGISTRY) {
            if (Object.prototype.hasOwnProperty.call(REGISTRY, k)) out.push(k);
        }
        return out;
    }

    // ───────────────────────────────────────────────────────────────
    // Manifest — ~60 textbook-validated entries for common WTS inputs
    //
    // Each entry references the input id used by the calculators in
    // 23-27 (ESD, hydrate, liquid-line, pipe-life) plus generic ids
    // commonly seen in WTS legacy code. References follow API / GPSA
    // textbook citations where possible.
    // ───────────────────────────────────────────────────────────────
    var MANIFEST = {

        // ─── Fluid properties ───────────────────────────────────────
        'gasSG': {
            description: 'Specific gravity of produced gas relative to air at standard conditions. ' +
                         'Sweet gas typically 0.60-0.70; richer condensate gas can reach 0.85+.',
            typicalRange: '0.55 – 0.85 (0.65 typical sweet gas)',
            units: 'dimensionless (air = 1)',
            references: ['GPSA Section 23']
        },
        'oilAPI': {
            description: 'API gravity of stock-tank oil. < 20 = heavy; 20-30 = medium; ' +
                         '30-40 = light; > 40 = condensate-range. Affects density and PVT correlations.',
            typicalRange: '15 – 60 °API',
            units: '°API',
            references: ['API MPMS Ch. 11']
        },
        'oilSG': {
            description: 'Stock-tank oil specific gravity at 60 °F. Tied to API via ' +
                         'γo = 141.5 / (131.5 + °API). Use either API or SG — not both.',
            typicalRange: '0.74 – 0.97',
            units: 'dimensionless (water = 1)',
            references: ['API MPMS Ch. 11']
        },
        'waterSG': {
            description: 'Produced water specific gravity. 1.00 = fresh; 1.07-1.10 = ' +
                         'high-salinity brine typical of NS / GoM completions.',
            typicalRange: '1.00 – 1.15',
            units: 'dimensionless'
        },
        'oilGOR': {
            description: 'Producing gas-oil ratio at separator conditions. ' +
                         'Black oil 200-1500; volatile oil 1500-3500; gas condensate 3500+.',
            typicalRange: '200 – 100,000 scf/STB',
            units: 'scf/STB'
        },
        'CO2': {
            description: 'Mole fraction of CO2 in produced gas. > 2 % triggers CRA material ' +
                         'review. > 10 % materially affects compressibility (use DAK Z-correlation).',
            typicalRange: '0 – 30 mol %',
            units: 'mol %',
            references: ['NACE MR0175']
        },
        'H2S': {
            description: 'Mole fraction of H2S in produced gas. ANY measurable H2S triggers ' +
                         'sour-service material selection. Hard-cap PPE thresholds vary by jurisdiction.',
            typicalRange: '0 – 50,000 ppm (= 5 mol %)',
            units: 'mol % or ppm',
            references: ['NACE MR0175', 'API RP 49']
        },
        'N2': {
            description: 'Mole fraction of nitrogen in produced gas. Inert; reduces heating value ' +
                         'but otherwise benign. > 5 % bumps Z-factor noticeably.',
            typicalRange: '0 – 15 mol %',
            units: 'mol %'
        },

        // ─── Pressures ──────────────────────────────────────────────
        'wellheadPressure': {
            description: 'Flowing wellhead pressure (FWHP). Test cap is the operator MAWP ' +
                         '(5,000 / 10,000 / 15,000 psig classes). Static SITHP > FWHP always.',
            typicalRange: '500 – 15,000 psig',
            units: 'psig'
        },
        'separatorPressure': {
            description: 'Operating pressure of the test separator. Choose to match downstream ' +
                         'flare arrival pressure or sales-line constraint. Affects Bo and GOR split.',
            typicalRange: '50 – 1,200 psig (typical 250-500)',
            units: 'psig'
        },
        'mawp': {
            description: 'Maximum allowable working pressure of the section. Code-rated cold ' +
                         'rating (ANSI 600 = 1,440 psig; 900 = 2,220 psig; 1500 = 3,705 psig; 2500 = 6,170 psig).',
            typicalRange: '285 – 15,000 psig',
            units: 'psig',
            references: ['ASME B16.5']
        },
        'rdSetting': {
            description: 'Rupture-disc or PSV setpoint. Standard practice: RD ≤ 110 % MAWP. ' +
                         'Hi-pilot fires below this to give ESD time to act before the RD blows.',
            typicalRange: 'MAWP × 1.10',
            units: 'psig',
            references: ['API 520 Pt. I']
        },
        'hiPilotSetting': {
            description: 'High-pressure ESD pilot setpoint. Must close all SSVs and stop ' +
                         'gas accumulation before the section pressure reaches the rupture disc.',
            typicalRange: 'MAWP × (0.90 – 0.95)',
            units: 'psig',
            references: ['API 14C']
        },
        'loPilotSetting': {
            description: 'Low-pressure ESD pilot setpoint. Catches leaks / line breaks on ' +
                         'the downstream side. Set above hydrate / wax dropout pressure.',
            typicalRange: 'Operating × (0.50 – 0.75)',
            units: 'psig',
            references: ['API 14C']
        },
        'designPressure': {
            description: 'Design pressure used to size pipework wall. Usually MAWP plus a small ' +
                         'margin (5-10 %). Drives the Barlow wall-thickness calculation.',
            typicalRange: '285 – 15,000 psig',
            units: 'psig'
        },

        // ─── Temperatures ───────────────────────────────────────────
        'wellheadTemp': {
            description: 'Flowing wellhead temperature. Set by reservoir geothermal gradient ' +
                         '(~1.5 °F per 100 ft TVD onshore) less J-T cooling at restriction.',
            typicalRange: '60 – 350 °F',
            units: '°F'
        },
        'sectionGasTemp': {
            description: 'Average gas temperature inside the protected section during ESD. Use ' +
                         'flowing temp post-choke (often 50-100 °F below wellhead).',
            typicalRange: '40 – 250 °F',
            units: '°F'
        },
        'reservoirTemp': {
            description: 'Reservoir static temperature. Onshore gradient ~1.5 °F per 100 ft TVD ' +
                         '(mean surface 60 °F). Offshore use mudline temp + geothermal.',
            typicalRange: '80 – 400 °F',
            units: '°F'
        },
        'ambientTemp': {
            description: 'Ambient air / sea-water temperature surrounding the test pipework. ' +
                         'Drives the surface heat-loss boundary for hydrate temperature checks.',
            typicalRange: '32 – 100 °F (sea: 35-85)',
            units: '°F'
        },
        'designTemp': {
            description: 'Design temperature used for pipework selection. Pair the minimum value ' +
                         'with Charpy / A333-Gr6 requirements; the maximum with rating de-rate tables.',
            typicalRange: '-50 °F to +250 °F',
            units: '°F',
            references: ['ASME B31.3']
        },

        // ─── Flow rates ────────────────────────────────────────────
        'gasFlowRate': {
            description: 'Sustained gas production rate at test separator conditions. ' +
                         'Standard sets the duty for flare, separator, sand and erosion calcs.',
            typicalRange: '1 – 200 MMscf/d',
            units: 'MMscf/d'
        },
        'gasBackflowRate': {
            description: 'Worst-case backflow / breakthrough rate used in ESD sizing. ' +
                         'Often equals the test rate; can be higher when upstream MAWP > section MAWP.',
            typicalRange: '1 – 200 MMscf/d',
            units: 'MMscf/d'
        },
        'oilRate': {
            description: 'Oil rate at stock-tank conditions. Together with gas rate sets ' +
                         'producing GOR. Drives liquid handling and mixture velocity.',
            typicalRange: '50 – 30,000 STB/d',
            units: 'STB/d'
        },
        'waterRate': {
            description: 'Produced water rate. Drives water-cut, hydrate risk and corrosion. ' +
                         '> 30 % BSW triggers free-water knock-out review.',
            typicalRange: '0 – 30,000 bbl/d',
            units: 'bbl/d'
        },

        // ─── Choke / flow elements ─────────────────────────────────
        'chokeBeanSize': {
            description: 'Choke bean opening expressed in 64ths of an inch. < 8/64 = ' +
                         'test-orifice range (only at low rates); > 64/64 = fully open / no choke.',
            typicalRange: '8 – 128 (in 64ths)',
            units: '/64 inch'
        },
        'chokeDischargeCoeff': {
            description: 'Cd for the choke insert. Standard positive choke ~0.85; V-port / ' +
                         'needle-and-seat 0.60-0.70; multi-stage cage 0.75-0.85.',
            typicalRange: '0.60 – 0.95 (0.85 default)',
            units: 'dimensionless',
            references: ['ISA RP75']
        },
        'lcvSize': {
            description: 'Level-control valve trim size. Sized for slug + steady oil rate at ' +
                         'separator dP. Undersize causes blowby; oversize causes hunting.',
            typicalRange: '0.5 – 4 inch',
            units: 'inch'
        },
        'roSize': {
            description: 'Restriction-orifice (RO) bore diameter on the downstream liquid line. ' +
                         'Sized to limit blowby velocity below 60 ft/s.',
            typicalRange: '2/64 – 32/64 inch',
            units: '/64 inch'
        },

        // ─── Wellbore / reservoir parameters ───────────────────────
        'skin': {
            description: 'Mechanical skin factor (van Everdingen). Negative = stimulated (acid ' +
                         'or frac); 0 = ideal; positive = damage / partial penetration.',
            typicalRange: '-5 to +30',
            units: 'dimensionless',
            references: ['SPE Tex. Vol. 1']
        },
        'wellboreStorage': {
            title: 'Wellbore storage',
            description: 'Volume the wellbore stores or releases per psi, which delays the reservoir response ' +
                         'at early time. PRiSM reports C in bbl/psi and the dimensionless CD = 0.8936·C/(φ·ct·h·rw²). ' +
                         'Shut-in at surface gives large storage; a downhole shut-in valve gives small storage.',
            typicalRange: 'C 1e-4 – 0.1 bbl/psi (CD 1 – 100,000)',
            units: 'bbl/psi (C) · dimensionless (CD)',
            references: ['Bourdet, 2002 Ch. 2']
        },
        'permeability': {
            description: 'Effective permeability to the flowing phase. Tight gas < 0.1 mD; ' +
                         'conventional 1-1000 mD; very high-perm carbonate > 1,000 mD.',
            typicalRange: '0.001 – 10,000 mD',
            units: 'millidarcy'
        },
        'porosity': {
            description: 'Total porosity. Tight 5-8 %; conventional sandstone 15-25 %; ' +
                         'high-porosity chalk / carbonate 25-35 %.',
            typicalRange: '0.05 – 0.40',
            units: 'fraction'
        },
        'reservoirThickness': {
            description: 'Net pay thickness used in kh and OOIP/OGIP calculations. ' +
                         'Use net rather than gross (cut-off-based).',
            typicalRange: '5 – 500 ft',
            units: 'ft'
        },
        'reservoirPressure': {
            description: 'Initial or current reservoir pressure (static). Drives drive index ' +
                         'and the IPR / VLP curves.',
            typicalRange: '500 – 15,000 psia',
            units: 'psia'
        },
        'wellboreRadius': {
            description: 'Wellbore radius at the producing interval. Open-hole = bit radius; ' +
                         'cased-hole-perforated use casing ID/2.',
            typicalRange: '0.25 – 0.75 ft (typical 0.354 for 8.5")',
            units: 'ft'
        },
        'compressibility': {
            description: 'Total system compressibility ct = co·So + cw·Sw + cg·Sg + cf. ' +
                         'Gas wells dominated by cg (~1/p); oil wells by co (~10⁻⁵ psi⁻¹).',
            typicalRange: '1e-6 to 1e-3 1/psi',
            units: '1/psi'
        },
        'viscosity': {
            description: 'Flowing-phase viscosity at reservoir conditions. Use Beggs-Robinson ' +
                         'for dead oil + saturation correction for live oil.',
            typicalRange: 'Gas 0.01-0.04 cp; oil 0.3-100 cp',
            units: 'cp',
            references: ['Beggs & Robinson 1975']
        },
        'formationVolumeFactor': {
            title: 'Formation volume factor',
            description: 'Reservoir volume per surface volume. Oil Bo: 1.05–2.5 RB/STB. Gas Bg: about ' +
                         '0.4–5 RB/Mscf (0.75 RB/Mscf at 4,000 psia and 180 °F). Use Standing or DAK correlations ' +
                         'at reservoir pressure and temperature.',
            typicalRange: 'Bo 1.05 – 2.5 RB/STB · Bg 0.4 – 5 RB/Mscf',
            units: 'RB/STB (oil) or RB/Mscf (gas)',
            references: ['Standing 1947', 'GPSA']
        },

        // ─── ESD timing ────────────────────────────────────────────
        'esdResponseTime': {
            description: 'Time from ESD demand to last SSV fully closed. Onshore standard ' +
                         '5 s; offshore 10 s; deepwater subsea up to 30 s.',
            typicalRange: '5 – 30 s',
            units: 's',
            references: ['API 14C', 'NORSOK S-001']
        },
        'sectionVolume': {
            description: 'Internal volume of the protected section. Sum of pipe + vessel + ' +
                         'manifold contributions. Drives the gas inventory build-up rate.',
            typicalRange: '5 – 500 ft³',
            units: 'ft³'
        },

        // ─── Sand & erosion ────────────────────────────────────────
        'sandProduction': {
            description: 'Produced sand concentration. Frac-pack & gravel-pack typically < 1; ' +
                         'cased-and-perforated 1-10; open-hole / under-completed up to 100+.',
            typicalRange: '0.01 – 100 lb/MMscf',
            units: 'lb/MMscf',
            references: ['SPE 30435']
        },
        'salamaConstant': {
            description: 'Salama c-factor for sand-erosion screening. 200 = piggable Cushion-tee ' +
                         'spool; 300 = baseline carbon steel; 400+ = standard LR elbow.',
            typicalRange: '200 – 600 (300 typical)',
            units: 'dimensionless',
            references: ['Salama 2000']
        },
        'mixtureVelocity': {
            description: 'Multiphase mixture velocity. API RP 14E erosion velocity Ve = C / √ρm ' +
                         'with C = 100 for continuous service.',
            typicalRange: '< 60 ft/s desired',
            units: 'ft/s',
            references: ['API RP 14E']
        },

        // ─── Hydrate management ────────────────────────────────────
        'hydrateInhibitor': {
            description: 'Choice of thermodynamic inhibitor: MeOH (volatile, low cost, lost to gas), ' +
                         'MEG (recoverable, viscous at low T), DEG (high-temp service).',
            typicalRange: 'MeOH / MEG / DEG',
            units: '',
            references: ['Hammerschmidt 1934']
        },
        'inhibitorPurity': {
            description: 'Mass fraction of inhibitor in injected stream (vs. water). ' +
                         'MeOH usually 95-100 %; MEG usually 80-90 %.',
            typicalRange: '0.80 – 1.00',
            units: 'mass fraction'
        },
        'hydrateSubcooling': {
            description: 'Margin below hydrate equilibrium temperature. < 3 °F = high risk; ' +
                         '3-7 °F = monitor; > 7 °F = inhibited / safe.',
            typicalRange: '0 – 15 °F',
            units: '°F'
        },

        // ─── Tubular / pipework geometry ───────────────────────────
        'pipeNPS': {
            description: 'Nominal pipe size. Common test pipework: 2", 3", 4" for flowlines, ' +
                         '6"-8" for separators / manifolds.',
            typicalRange: '2 – 12 inch',
            units: 'inch (NPS)',
            references: ['ANSI B36.10']
        },
        'pipeSchedule': {
            description: 'Pipe wall schedule. SCH 80 = 1,500-class flowline; SCH 160 = 5K hot-tap; ' +
                         'SCH 180 / XXH = 10K-15K choke manifold.',
            typicalRange: '40 / 80 / 160 / 180 / XXH',
            units: '',
            references: ['ANSI B36.10']
        },
        'measuredWT': {
            description: 'Latest UT-measured wall thickness. Compare to mill-tolerance minimum ' +
                         '(0.875 × nominal) and to failure WT for remaining-life calc.',
            typicalRange: '0.10 – 1.5 inch',
            units: 'inch',
            references: ['API RP 574']
        },
        'minSpecWT': {
            description: 'Minimum spec wall thickness — usually 0.875 × nominal (mill tolerance). ' +
                         'Used as the alarm threshold for in-service inspection.',
            typicalRange: '0.10 – 1.3 inch',
            units: 'inch'
        },
        'failureWT': {
            description: 'Wall thickness at which the section is condemned. Often the ' +
                         'Barlow-calculated wall at operating P + a safety margin (0.024" floor).',
            typicalRange: '0.020 – 0.10 inch',
            units: 'inch',
            references: ['API 579-1']
        },
        'pipeLength': {
            description: 'Straight-pipe length of the segment. Affects only volume-based ' +
                         'calcs (ESD section inventory). Erosion is a local-velocity calc.',
            typicalRange: '5 – 500 ft',
            units: 'ft'
        },

        // ─── PRiSM-specific (legacy ids kept; the live inputs use prism_* ids below) ───
        'PRiSM_kh': {
            title: 'Permeability-thickness kh',
            description: 'How easily the whole pay interval lets fluid flow. From the semilog slope m: ' +
                         'kh = 162.6·q·B·μ/m (oil). Gas with pseudo-pressure: kh = 1637·q·T/m.',
            typicalRange: '1 – 100,000 md·ft',
            units: 'md·ft'
        },
        'PRiSM_pInitial': {
            title: 'Initial reservoir pressure',
            description: 'Reservoir pressure before the test disturbed it. In a drawdown the pressure drop ' +
                         'is measured from this value, so skin depends on it directly. In a buildup the ' +
                         'straight line extrapolates to p*, which equals pi when no boundary has been felt.',
            typicalRange: '500 – 15,000 psia',
            units: 'psia'
        },
        'PRiSM_skin': {
            title: 'Skin',
            description: 'Extra pressure drop near the wellbore, in dimensionless form. Negative means ' +
                         'stimulated (acidised or fractured); positive means damage or restricted entry.',
            typicalRange: '-5 to +30',
            units: 'dimensionless'
        },
        'PRiSM_xf': {
            title: 'Fracture half-length',
            description: 'Length of one wing of a hydraulic fracture. Seen as a half-slope derivative ' +
                         '(linear flow) before radial flow.',
            typicalRange: '20 – 800 ft',
            units: 'ft'
        },
        'PRiSM_FcD': {
            title: 'Fracture conductivity (dimensionless)',
            description: 'How easily the fracture carries flow compared with the rock: FcD = kf·w/(k·xf). ' +
                         'Below about 10 the fracture itself restricts flow; above 30 it behaves as infinite.',
            typicalRange: '0.5 – 1000',
            units: 'dimensionless',
            references: ['Cinco-Ley & Samaniego 1981']
        },

        // ─── Misc utilities ────────────────────────────────────────
        'unitsSystem': {
            description: 'Imperial = psi, °F, ft, bbl, STB, scf. Metric = kPa, °C, m, m³, Sm³. ' +
                         'Toggle applies to inputs AND result formatting.',
            typicalRange: 'imperial / metric',
            units: ''
        },
        'clientName': {
            description: 'Operator / client name printed on report headers. Free text.',
            typicalRange: '',
            units: ''
        },
        'wellName': {
            description: 'Well identifier (API#, UWI, friendly name) for report headers.',
            typicalRange: '',
            units: ''
        },
        'fieldName': {
            description: 'Field / asset / block name. Appears on Quick Report header.',
            typicalRange: '',
            units: ''
        }
    };

    // Auto-register manifest at module load.
    defineMany(MANIFEST);

    // ───────────────────────────────────────────────────────────────
    // PRiSM manifest — ids used by the live PRiSM inputs:
    //   prism_well_*   Well & Test card (16-pvt.js)
    //   prism_sl_*     straight-line (semilog) panel (34-semilog-skin.js)
    //   prism_match_*  type-curve match readouts (Tab 5)
    //   prism_reg_* / prism_regress_*  regression controls (Tab 6)
    //   prism_help_*   result quantities, bound through data-wts-help="…"
    //                  or the TEXT_BINDINGS below (report, results tables)
    // Plain language first; the formula, when useful, comes last.
    // ───────────────────────────────────────────────────────────────
    function _entry(title, description, typicalRange, units) {
        return { title: title, description: description, typicalRange: typicalRange || '', units: units || '' };
    }
    var H_PI = _entry('Initial reservoir pressure',
        'Reservoir pressure before this test disturbed it. In a drawdown the pressure drop is measured from this ' +
        'value, so skin depends on it directly. If it is left blank the first data point is used instead and ' +
        'skin will be wrong.', '500 – 15,000 psia', 'psia');
    var H_K = _entry('Permeability',
        'How easily the rock lets fluid flow. It comes from the flat part of the derivative (radial flow) or ' +
        'from the semilog slope: k = kh / h.', '0.01 – 5,000 md', 'md');
    var H_KH = _entry('Permeability-thickness',
        'Permeability times net pay: the flow capacity of the whole interval. kh = 162.6·q·B·μ/m from the ' +
        'semilog slope m, or 70.6·q·B·μ/Δp′ from the derivative plateau.', '1 – 100,000 md·ft', 'md·ft');
    var H_S = _entry('Skin',
        'Extra pressure drop close to the well, as a number. Negative means the well is stimulated (acid or ' +
        'fracture); zero means undamaged; positive means damage, restricted entry or partial penetration.',
        '-5 to +30', 'dimensionless');
    var H_C = _entry('Wellbore storage',
        'Volume the wellbore stores or gives back per psi. It hides the reservoir at early time (the unit-slope ' +
        'part of the log-log plot). C = q·B·Δt/(24·Δp) on the unit slope.', '1e-4 – 0.1', 'bbl/psi');
    var H_CD = _entry('Dimensionless storage',
        'Wellbore storage in dimensionless form: CD = 0.8936·C/(φ·ct·h·rw²).', '1 – 100,000', 'dimensionless');
    var H_RINV = _entry('Radius of investigation',
        'How far into the reservoir the pressure disturbance has travelled by the end of the data: ' +
        'rinv = √(k·t/(948·φ·μ·ct)). Features further away than this cannot be seen in the test.', '', 'ft');
    var H_DPS = _entry('Pressure drop due to skin',
        'Part of the drawdown that is lost near the wellbore because of skin: ΔpS = 141.2·q·B·μ·S/kh ' +
        '(= 0.869·m·S). Removing the skin would recover this pressure.', '', 'psi');
    var H_FE = _entry('Flow efficiency',
        'Share of the drawdown that does useful work in the reservoir: FE = (p̄ − pwf − ΔpS)/(p̄ − pwf). ' +
        '1 = undamaged; 0.76 means the well produces 76 % of its undamaged rate at the same drawdown.',
        '0.2 – 1.5', 'fraction');
    var H_DR = _entry('Damage ratio', 'The inverse of flow efficiency (DR = 1/FE). Above 1 the well is damaged.',
        '0.7 – 5', 'dimensionless');
    var H_J = _entry('Productivity index', 'Rate per psi of drawdown at the time of the test: J = q/(p̄ − pwf).',
        '', 'STB/d/psi (oil) · Mscf/d/psi (gas)');
    var H_JI = _entry('Productivity index without skin',
        'Rate per psi the well would give if the skin were removed: J_ideal = q/(p̄ − pwf − ΔpS).',
        '', 'STB/d/psi (oil) · Mscf/d/psi (gas)');
    var H_RWA = _entry('Effective wellbore radius',
        'Radius of an undamaged well that would behave like this one: rw′ = rw·e^(−S). Larger than rw for a ' +
        'stimulated well, smaller for a damaged one.', '', 'ft');
    var H_M = _entry('Semilog slope',
        'Pressure change per log cycle of time on the straight line through the radial-flow data. ' +
        'A steeper line means lower kh: kh = 162.6·q·B·μ/m.', '', 'psi/cycle');
    var H_P1 = _entry('Pressure at 1 hour on the line',
        'Pressure read from the straight line (extended if needed) at 1 hour. Skin is calculated from it, ' +
        'not from the measured pressure at 1 hour.', '', 'psia');
    var H_PSTAR = _entry('Extrapolated pressure p*',
        'Pressure the buildup straight line reaches at infinite shut-in time. With no boundary felt it equals ' +
        'the initial reservoir pressure; later in the life of a field it is used to estimate average pressure.',
        '', 'psia');
    var H_XF = _entry('Fracture half-length',
        'Length of one wing of a hydraulic fracture, seen as a half-slope derivative before radial flow.',
        '20 – 800 ft', 'ft');
    var H_LH = _entry('Horizontal length', 'Producing length of a horizontal well.', '500 – 10,000 ft', 'ft');
    var H_PM = _entry('Pressure match (log PM)',
        'Vertical position of the model type curve on the log-log plot. It sets kh: kh = 141.2·q·B·μ·PM.',
        '', 'log10(1/psi)');
    var H_TM = _entry('Time match (log TM)',
        'Horizontal position of the model type curve on the log-log plot. With kh known it sets storage ' +
        'and skin.', '', 'log10(1/h)');
    var H_R2 = _entry('R²', 'Share of the variation in the data that the model explains. 1 is a perfect fit; ' +
        'a good pressure match is usually above 0.999.', '0 – 1', '');
    var H_RMSE = _entry('RMSE', 'Typical size of the misfit between the data and the model, in the data units ' +
        '(psi for pressure). Compare it with the gauge resolution.', '', 'psi');
    var H_AIC = _entry('AIC', 'Fit score that rewards a close fit and penalises extra parameters. Lower is ' +
        'better; only differences between models matter.', '', '');
    var H_DAIC = _entry('ΔAIC', 'Difference in AIC from the best model. Below 2 the data cannot tell the models ' +
        'apart; above 10 the best model is strongly preferred.', '', '');

    var PRISM_MANIFEST = {
        // Well & Test card (16-pvt.js)
        'prism_well_testType': _entry('Test type',
            'What the well was doing while the gauge recorded: flowing (drawdown), shut in after flowing (buildup), ' +
            'injecting, or shut in after injecting (falloff). Auto-detect reads it from the rate column.',
            'Auto / Drawdown / Buildup / Injection / Falloff', ''),
        'prism_well_pi': H_PI,
        'prism_well_tp': _entry('Producing time before shut-in',
            'How long the well flowed before it was shut in, as an equivalent constant-rate time (cumulative ' +
            'volume ÷ last rate). Needed for Horner and superposition plots of a buildup. Leave blank to work ' +
            'it out from the rate history.', '', 'h'),
        'prism_well_tShut': _entry('Shut-in time',
            'Clock time, in hours from the start of the data, when the well was closed. Leave blank to detect it ' +
            'from the rate column.', '', 'h'),
        'prism_well_pwf0': _entry('Flowing pressure at shut-in',
            'Bottom-hole pressure at the moment the well was closed. In a buildup the pressure rise is measured ' +
            'from this value. Leave blank to read it from the data.', '', 'psia'),
        'prism_well_q': _entry('Rate',
            'Surface rate during the analysed flow period; for a buildup, the rate just before shut-in. ' +
            'Oil and water in STB/d, gas in Mscf/d.', '', 'STB/d or Mscf/d'),
        'prism_well_q_fromdata': _entry('Rate from the data',
            'Tick to use the loaded rate column instead of the number typed in the rate box.', '', ''),
        'prism_well_rw': _entry('Wellbore radius',
            'Radius of the hole or casing at the producing interval: half the bit or casing diameter.',
            '0.25 – 0.5 ft (0.354 ft for an 8½-in hole)', 'ft'),
        'prism_well_h': _entry('Net pay',
            'Thickness of the rock that actually flows into the well. Permeability is kh divided by this value.',
            '5 – 500 ft', 'ft'),
        'prism_well_phi': _entry('Porosity',
            'Fraction of the rock volume that is pore space (0.18 = 18 %). It affects storage, skin and radius ' +
            'of investigation, not permeability.', '0.05 – 0.35', 'fraction'),
        'prism_well_fluidType': _entry('Fluid',
            'Main fluid flowing into the well. Gas switches the analysis to pseudo-pressure and rates to Mscf/d.',
            'Oil / Gas / Water', ''),
        'prism_well_B': _entry('Formation volume factor',
            'Reservoir barrels per surface barrel (oil) or per Mscf (gas). Leave blank to use the PVT estimate.',
            'Oil 1.05 – 2.0 RB/STB · gas 0.4 – 5 RB/Mscf', 'RB/STB or RB/Mscf'),
        'prism_well_mu': _entry('Viscosity',
            'Viscosity of the flowing fluid at reservoir conditions. Leave blank to use the PVT estimate.',
            'Oil 0.3 – 100 cp · gas 0.01 – 0.04 cp', 'cp'),
        'prism_well_ct': _entry('Total compressibility',
            'How much the rock and fluids compress per psi of pressure change. Oil wells are about 1e-5 1/psi; ' +
            'gas wells are close to 1/p. Leave blank to use the PVT estimate.', '1e-6 – 1e-3', '1/psi'),
        'prism_well_pvt_btn': _entry('Estimate from PVT',
            'Opens correlations that estimate B, μ and ct from oil and gas gravity, temperature and pressure.', '', ''),
        'prism_well_accept_all': _entry('Accept all defaults',
            'Confirms every value still marked "default" so the report lists them as checked.', '', ''),

        // Straight-line (semilog) panel (34-semilog-skin.js)
        'prism_sl_method': _entry('Straight-line method',
            'MDH for a drawdown, Horner for a buildup after one rate, superposition for several rates. ' +
            'Auto picks the method from the test type.', '', ''),
        'prism_sl_t0': _entry('Start of the straight-line window',
            'First time (hours) of the stretch where the derivative is flat (radial flow).', '', 'h'),
        'prism_sl_t1': _entry('End of the straight-line window',
            'Last time (hours) of the stretch where the derivative is flat (radial flow).', '', 'h'),
        'prism_sl_auto': _entry('Auto window',
            'Finds the longest flat stretch of the derivative and fits the line there.', '', ''),
        'prism_sl_run': _entry('Analyse straight line',
            'Fits the line in the window and recalculates permeability, skin and the skin results.', '', ''),
        'prism_sl_seed': _entry('Use as start values',
            'Copies k and S from the straight line into the model as the starting point for regression.', '', ''),
        'prism_sl_report': _entry('Store in report', 'Keeps this straight-line result in the report.', '', ''),
        'prism_sl_hp': _entry('Open interval',
            'Length of the perforated (open) interval. Used to split skin into damage and partial-penetration parts.',
            '', 'ft'),
        'prism_sl_kvkh': _entry('Vertical to horizontal permeability',
            'kv/kh ratio. Low values make the partial-penetration and slant skins larger.', '0.01 – 1', 'fraction'),
        'prism_sl_theta': _entry('Well deviation',
            'Angle of the well from vertical. A slanted well has a negative geometric skin.', '0 – 75°', 'deg'),
        'prism_sl_xf': H_XF,
        'prism_sl_dtable': _entry('Skin at several rates',
            'Skin found at each flow rate. A straight line through them separates rate-dependent (turbulent) ' +
            'skin D·q from mechanical skin.', '', ''),

        // Type-curve match readouts (Tab 5) and regression controls (Tab 6)
        'prism_match_logPM': H_PM, 'prism_match_logTM': H_TM,
        'prism_match_kh': H_KH, 'prism_match_k': H_K, 'prism_match_C': H_C, 'prism_match_S': H_S,
        'prism_match_rmse': _entry('Match misfit',
            'Typical misfit between the data and the moved type curve on the log-log plot, in log cycles. ' +
            'Below about 0.01 the curves lie on top of each other.', '', 'log10'),
        'prism_match_apply': _entry('Apply match',
            'Turns the curve position into permeability, storage and skin and makes them the current result.', '', ''),
        'prism_match_auto': _entry('Auto-align',
            'Moves the type curve to sit on the data automatically; the model shape is kept.', '', ''),
        'prism_reg_tmin': _entry('Fit window start', 'Earliest time (hours) used by the regression.', '', 'h'),
        'prism_reg_tmax': _entry('Fit window end', 'Latest time (hours) used by the regression.', '', 'h'),
        'prism_reg_floatPi': _entry('Fit the initial pressure',
            'Let the regression adjust pi as well. Use it when pi is uncertain; it needs data well into radial flow.',
            '', ''),
        'prism_reg_objective': _entry('What to match',
            'Pressure change only, or pressure change and its derivative together on the log-log plot (the ' +
            'derivative carries most of the information about the reservoir).', '', ''),
        'prism_regress_run': _entry('Run regression',
            'Adjusts the free parameters until the model best matches the data, and reports 95 % ranges.', '', ''),
        'prism_regress_auto': _entry('Model race',
            'Fits several candidate models and ranks them by AIC so you can compare them.', '', ''),
        'prism_bourdet_L': _entry('Derivative smoothing',
            'Width (in log cycles of time) used to smooth the pressure derivative. Larger values give a smoother ' +
            'curve but can blur short features. 0.1–0.2 is usual.', '0 – 0.5', ''),
        'prism_timefn': _entry('Time function',
            'How elapsed time is measured for the derivative. Superposition time accounts for earlier rates and ' +
            'is right for buildups; plain Δt suits a single drawdown.', '', ''),

        // Result quantities (bound by data-wts-help or TEXT_BINDINGS)
        'prism_help_k': H_K, 'prism_help_kh': H_KH, 'prism_help_S': H_S, 'prism_help_C': H_C, 'prism_help_Cd': H_CD,
        'prism_help_pi': H_PI, 'prism_help_rinv': H_RINV, 'prism_help_dpS': H_DPS, 'prism_help_FE': H_FE,
        'prism_help_DR': H_DR, 'prism_help_J': H_J, 'prism_help_Jideal': H_JI, 'prism_help_rwa': H_RWA,
        'prism_help_m': H_M, 'prism_help_p1hr': H_P1, 'prism_help_pstar': H_PSTAR, 'prism_help_xf': H_XF,
        'prism_help_Lh': H_LH, 'prism_help_logPM': H_PM, 'prism_help_logTM': H_TM, 'prism_help_r2': H_R2,
        'prism_help_rmse': H_RMSE, 'prism_help_aic': H_AIC, 'prism_help_dAIC': H_DAIC,
        'prism_report_notes': _entry('Analyst comments', 'Free text printed with the report (kept with the project).', '', '')
    };
    defineMany(PRISM_MANIFEST);

    // Row labels without ids (results tables written by other layers) are
    // matched by their text: [container selector, cell selector, [[regex, id], …]].
    var RESULT_ROWS = [
        [/^semilog slope|^slope m/i, 'prism_help_m'], [/^kh\b|permeability-thickness/i, 'prism_help_kh'],
        [/^permeability k|^k\b/i, 'prism_help_k'], [/^p at 1 h/i, 'prism_help_p1hr'],
        [/^extrapolated pressure/i, 'prism_help_pstar'], [/skin pressure drop|pressure drop due to skin/i, 'prism_help_dpS'],
        [/^flow efficiency/i, 'prism_help_FE'], [/^damage ratio/i, 'prism_help_DR'],
        [/^undamaged j|without skin/i, 'prism_help_Jideal'], [/^productivity index/i, 'prism_help_J'],
        [/effective wellbore radius/i, 'prism_help_rwa'], [/radius of investigation/i, 'prism_help_rinv'],
        [/^storage c|^wellbore storage c/i, 'prism_help_C'], [/dimensionless storage/i, 'prism_help_Cd'],
        [/^skin s\b|^skin\b/i, 'prism_help_S'], [/log pm|pressure match/i, 'prism_help_logPM'],
        [/log tm|time match/i, 'prism_help_logTM'], [/^r²|^r2\b/i, 'prism_help_r2'], [/^rmse/i, 'prism_help_rmse'],
        [/^Δaic|^daic/i, 'prism_help_dAIC'], [/^aic/i, 'prism_help_aic'], [/initial (reservoir )?pressure/i, 'prism_help_pi'],
        [/fracture half-length/i, 'prism_help_xf'], [/horizontal length/i, 'prism_help_Lh']
    ];
    var TEXT_BINDINGS = [
        { sel: '#prism_sl_table td.prism-sl-l', rules: RESULT_ROWS },
        { sel: '#prism_tab_5 .rl', rules: RESULT_ROWS },
        { sel: '#prism_tab_6 .rl', rules: RESULT_ROWS },
        { sel: '#prism_report_root .prism-rpt-kvr > span', rules: RESULT_ROWS }
    ];

    // ───────────────────────────────────────────────────────────────
    // DOM injection — ⓘ icon + tooltip layer
    // ───────────────────────────────────────────────────────────────
    var TOOLTIP_ID    = 'wts-tooltip-layer';
    var ICON_CLASS    = 'wts-help-icon';
    var INJECTED_ATTR = 'data-wts-tooltip';   // marker so we don't double-inject
    var styleInjected = false;

    function _injectStyles() {
        if (styleInjected || !_hasDoc) return;
        var s = document.createElement('style');
        s.setAttribute('data-wts-tooltip-styles', '1');
        s.textContent =
            '.' + ICON_CLASS + '{display:inline-block;margin-left:6px;width:14px;height:14px;' +
            'line-height:14px;text-align:center;border-radius:50%;font-size:11px;font-weight:600;' +
            'font-family:Segoe UI,sans-serif;cursor:help;color:#8b949e;background:transparent;' +
            'border:1px solid #30363d;opacity:.8;transition:color .15s,opacity .15s,background .15s;' +
            'user-select:none;vertical-align:middle}' +
            '.' + ICON_CLASS + ':hover,.' + ICON_CLASS + ':focus{color:#58a6ff;opacity:1;' +
            'border-color:#58a6ff;outline:none}' +
            '#' + TOOLTIP_ID + '{position:fixed;z-index:99999;max-width:min(340px,calc(100vw - 16px));padding:10px 12px;' +
            'background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;' +
            'font-family:Segoe UI,sans-serif;font-size:12px;line-height:1.45;' +
            'box-shadow:0 6px 24px rgba(0,0,0,.55);pointer-events:auto;opacity:0;' +
            'transition:opacity .12s;display:none}' +
            '#' + TOOLTIP_ID + '.visible{display:block;opacity:1}' +
            '#' + TOOLTIP_ID + ' .wts-tip-title{font-weight:600;color:#58a6ff;margin-bottom:4px;' +
            'font-size:12px}' +
            '#' + TOOLTIP_ID + ' .wts-tip-row{margin-top:4px}' +
            '#' + TOOLTIP_ID + ' .wts-tip-key{color:#8b949e;font-size:11px;text-transform:uppercase;' +
            'letter-spacing:.04em}' +
            '#' + TOOLTIP_ID + ' .wts-tip-val{color:#c9d1d9}' +
            '#' + TOOLTIP_ID + ' .wts-tip-ref{margin-top:6px;padding-top:6px;border-top:1px solid #30363d;' +
            'color:#8b949e;font-size:11px;font-style:italic}' +
            '#' + TOOLTIP_ID + ' .wts-tip-close{float:right;color:#8b949e;cursor:pointer;' +
            'font-size:14px;line-height:1;margin-left:8px}' +
            '#' + TOOLTIP_ID + ' .wts-tip-close:hover{color:#f85149}';
        try { document.head.appendChild(s); } catch (e) { _warn('tooltip style inject failed', e); }
        styleInjected = true;
    }

    function _ensureLayer() {
        if (!_hasDoc) return null;
        var layer = document.getElementById(TOOLTIP_ID);
        if (layer) return layer;
        layer = document.createElement('div');
        layer.id = TOOLTIP_ID;
        layer.setAttribute('role', 'tooltip');
        layer.setAttribute('aria-hidden', 'true');
        try { document.body.appendChild(layer); } catch (e) { return null; }
        // Close button delegation
        layer.addEventListener('click', function (ev) {
            var t = ev.target;
            if (t && t.className && String(t.className).indexOf('wts-tip-close') !== -1) {
                hide();
            }
        });
        return layer;
    }

    function _buildTipHTML(meta) {
        var parts = [];
        parts.push('<span class="wts-tip-close" title="Dismiss">&times;</span>');
        parts.push('<div class="wts-tip-title">' + _esc(meta._title || 'Help') + '</div>');
        if (meta.description) {
            parts.push('<div class="wts-tip-val">' + _esc(meta.description) + '</div>');
        }
        if (meta.typicalRange) {
            parts.push(
                '<div class="wts-tip-row">' +
                '<span class="wts-tip-key">Typical: </span>' +
                '<span class="wts-tip-val">' + _esc(meta.typicalRange) + '</span>' +
                '</div>'
            );
        }
        if (meta.units) {
            parts.push(
                '<div class="wts-tip-row">' +
                '<span class="wts-tip-key">Units: </span>' +
                '<span class="wts-tip-val">' + _esc(meta.units) + '</span>' +
                '</div>'
            );
        }
        if (meta.references && meta.references.length) {
            parts.push(
                '<div class="wts-tip-ref">Ref: ' + _esc(meta.references.join('; ')) + '</div>'
            );
        }
        return parts.join('');
    }

    function _positionLayer(layer, anchorEl) {
        if (!layer || !anchorEl || !anchorEl.getBoundingClientRect) return;
        var r = anchorEl.getBoundingClientRect();
        var W = (G.innerWidth || 1024);
        var H = (G.innerHeight || 768);
        // Default below the icon, left-aligned to icon.
        var top  = r.bottom + 6;
        var left = r.left;
        // Show in temporary off-screen position to measure size
        layer.style.left = '-9999px';
        layer.style.top  = '-9999px';
        layer.classList.add('visible');
        layer.setAttribute('aria-hidden', 'false');
        var lr = layer.getBoundingClientRect();
        // Clamp horizontally
        if (left + lr.width > W - 8) left = Math.max(8, W - lr.width - 8);
        if (left < 8) left = 8;
        // Flip above if would overflow bottom
        if (top + lr.height > H - 8) {
            top = r.top - lr.height - 6;
            if (top < 8) top = 8;
        }
        layer.style.left = left + 'px';
        layer.style.top  = top  + 'px';
    }

    function show(inputId, anchorEl) {
        if (!_hasDoc) return false;
        var meta = REGISTRY[inputId];
        if (!meta) {
            _warn('WTS_helpTooltips.show: unknown id', inputId);
            return false;
        }
        var titleMeta = {};
        for (var k in meta) titleMeta[k] = meta[k];
        titleMeta._title = _titleFor(inputId);
        _injectStyles();
        var layer = _ensureLayer();
        if (!layer) return false;
        layer.innerHTML = _buildTipHTML(titleMeta);
        var anchor = anchorEl;
        if (!anchor) {
            anchor = document.querySelector('[data-wts-tooltip-anchor="' + inputId + '"]') ||
                     _$(inputId) || document.body;
        }
        _positionLayer(layer, anchor);
        return true;
    }
    function hide() {
        if (!_hasDoc) return;
        var layer = _ensureLayer();
        if (!layer) return;
        layer.classList.remove('visible');
        layer.setAttribute('aria-hidden', 'true');
    }

    // Mouse-out hide with a small delay so users can move into the tooltip.
    var hideTimer = null;
    function _scheduleHide() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { hide(); hideTimer = null; }, 220);
    }
    function _cancelHide() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    // Bind hover + click events on a freshly-injected icon.
    function _bindIcon(icon, inputId) {
        if (!icon || !icon.addEventListener) return;
        icon.addEventListener('mouseenter', function () {
            _cancelHide();
            show(inputId, icon);
        });
        icon.addEventListener('mouseleave', _scheduleHide);
        icon.addEventListener('focus', function () {
            _cancelHide();
            show(inputId, icon);
        });
        icon.addEventListener('blur', _scheduleHide);
        icon.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            _cancelHide();
            show(inputId, icon);
        });
    }

    // Bind layer hover so it stays open while the cursor is inside.
    function _bindLayerHover() {
        if (!_hasDoc) return;
        var layer = _ensureLayer();
        if (!layer || layer._hoverBound) return;
        layer._hoverBound = true;
        layer.addEventListener('mouseenter', _cancelHide);
        layer.addEventListener('mouseleave', _scheduleHide);
    }

    // ───────────────────────────────────────────────────────────────
    // refresh() — scan DOM, inject ⓘ icons next to every tagged input
    //
    // An input is considered "tagged" when its id is in the REGISTRY.
    // The icon is appended just after the input element (or its parent
    // .fg-item if the input has a sibling <label> + <input> structure).
    // ───────────────────────────────────────────────────────────────
    function _alreadyHasIcon(inputEl) {
        if (!inputEl) return false;
        if (inputEl.getAttribute && inputEl.getAttribute(INJECTED_ATTR) === '1') return true;
        // also check sibling icons
        var p = inputEl.parentNode;
        if (p && p.querySelector) {
            var existing = p.querySelector('.' + ICON_CLASS + '[data-wts-id="' + inputEl.id + '"]');
            if (existing) return true;
        }
        return false;
    }

    // Where the icon goes: an explicit <label for=id>; the caption of a
    // wrapping <label> (the input sits inside the label); else the single
    // <label> that shares the input's parent. null -> right after the input.
    function _findLabelFor(inputEl) {
        if (!inputEl || !inputEl.id) return null;
        if (!_hasDoc) return null;
        var lbl = null;
        try { lbl = document.querySelector('label[for="' + inputEl.id + '"]'); } catch (e) { lbl = null; }
        if (lbl) return lbl;
        var wrap = (typeof inputEl.closest === 'function') ? inputEl.closest('label') : null;
        if (wrap) {
            var cap = wrap.firstElementChild || null;
            if (cap && cap !== inputEl && /^(SPAN|DIV|B|STRONG)$/i.test(cap.tagName || '') &&
                !(cap.querySelector && cap.querySelector('input,select,textarea'))) return cap;
            return null;   // the input is the label's first child: icon goes after the input
        }
        var p = inputEl.parentNode;
        if (p && p.querySelectorAll) {
            var labels = p.querySelectorAll('label');
            var inputs = p.querySelectorAll('input,select,textarea');
            if (labels.length === 1 && inputs.length <= 1 && labels[0].parentNode === p) return labels[0];
        }
        return null;
    }

    function _makeIcon(id) {
        var icon = document.createElement('span');
        icon.className = ICON_CLASS;
        icon.setAttribute('role', 'button');
        icon.setAttribute('tabindex', '0');
        icon.setAttribute('aria-label', 'Help: ' + _titleFor(id));
        icon.setAttribute('data-wts-id', id);
        icon.setAttribute('data-wts-tooltip-anchor', id);
        icon.title = (REGISTRY[id] && REGISTRY[id].description) || 'Help';
        icon.innerHTML = 'i';
        _bindIcon(icon, id);
        return icon;
    }

    function _injectIconForId(inputId) {
        if (!_hasDoc) return false;
        var el = _$(inputId);
        if (!el) return false;
        if (_alreadyHasIcon(el)) return false;
        var icon = _makeIcon(inputId);
        // Mount the icon next to the label (preferred) or just after the input
        var anchorEl = _findLabelFor(el);
        if (anchorEl && anchorEl.appendChild) {
            try { anchorEl.appendChild(icon); }
            catch (e) {
                try {
                    if (el.parentNode) el.parentNode.insertBefore(icon, el.nextSibling);
                } catch (e2) {}
            }
        } else {
            try {
                if (el.parentNode) el.parentNode.insertBefore(icon, el.nextSibling);
            } catch (e) {}
        }
        try { el.setAttribute(INJECTED_ATTR, '1'); } catch (e) {}
        return true;
    }

    // Any element can ask for help with data-wts-help="<registry id>"; the
    // icon is appended inside it.
    var BOUND_ATTR = 'data-wts-help-bound';
    function _appendIcon(el, id) {
        if (!el || !REGISTRY[id]) return false;
        if (el.getAttribute && el.getAttribute(BOUND_ATTR) === id) return false;
        try {
            el.appendChild(document.createTextNode(' '));
            el.appendChild(_makeIcon(id));
            el.setAttribute(BOUND_ATTR, id);
        } catch (e) { return false; }
        return true;
    }
    function _bindAttributes() {
        var n = 0, els;
        try { els = document.querySelectorAll('[data-wts-help]'); } catch (e) { return 0; }
        for (var i = 0; i < els.length; i++) {
            if (_appendIcon(els[i], els[i].getAttribute('data-wts-help'))) n++;
        }
        return n;
    }
    // Row labels written by other layers without ids, matched by their text.
    function _bindText() {
        var n = 0;
        for (var b = 0; b < TEXT_BINDINGS.length; b++) {
            var els;
            try { els = document.querySelectorAll(TEXT_BINDINGS[b].sel); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.getAttribute && el.getAttribute(BOUND_ATTR)) continue;
                var txt = String(el.textContent || '').trim();
                var rules = TEXT_BINDINGS[b].rules;
                for (var r = 0; r < rules.length; r++) {
                    if (rules[r][0].test(txt)) { if (_appendIcon(el, rules[r][1])) n++; break; }
                }
            }
        }
        return n;
    }

    function refresh() {
        if (!_hasDoc) return 0;
        _injectStyles();
        _bindLayerHover();
        var n = 0;
        for (var id in REGISTRY) {
            if (Object.prototype.hasOwnProperty.call(REGISTRY, id)) {
                if (_injectIconForId(id)) n++;
            }
        }
        n += _bindAttributes();
        n += _bindText();
        return n;
    }

    // Auto-refresh whenever the SPA mutates its main content area.
    // We watch document.body with a MutationObserver and debounce.
    var refreshTimer = null;
    function _scheduleRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            try { refresh(); } catch (e) { _warn('tooltip refresh failed', e); }
        }, 150);
    }

    function _installObserver() {
        if (!_hasDoc || !G.MutationObserver) return;
        var body = document.body;
        if (!body || body._wtsTooltipObserverInstalled) return;
        body._wtsTooltipObserverInstalled = true;
        try {
            var mo = new G.MutationObserver(function (muts) {
                // Only refresh if a mutation potentially added a tagged input
                for (var i = 0; i < muts.length; i++) {
                    if (muts[i].addedNodes && muts[i].addedNodes.length) {
                        _scheduleRefresh();
                        return;
                    }
                }
            });
            mo.observe(body, { childList: true, subtree: true });
        } catch (e) { _warn('tooltip observer failed', e); }
    }

    // ───────────────────────────────────────────────────────────────
    // Admin UI — list all registered tooltip entries (QA helper)
    // ───────────────────────────────────────────────────────────────
    function renderHelpTooltipsManager(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;
        var ids = list().sort();
        var rows = '';
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var m = REGISTRY[id];
            rows +=
                '<tr>' +
                '<td style="padding:4px 8px;font-family:Courier New,monospace;color:#58a6ff">' +
                _esc(id) + '</td>' +
                '<td style="padding:4px 8px;color:#c9d1d9">' + _esc(m.description) + '</td>' +
                '<td style="padding:4px 8px;color:#c9d1d9">' + _esc(m.typicalRange) + '</td>' +
                '<td style="padding:4px 8px;color:#c9d1d9">' + _esc(m.units) + '</td>' +
                '<td style="padding:4px 8px;color:#8b949e;font-style:italic">' +
                _esc((m.references || []).join('; ')) + '</td>' +
                '</tr>';
        }
        container.innerHTML =
            '<div class="card">' +
            '<div class="card-title">Help Tooltip Registry (' + ids.length + ' entries)</div>' +
            '<div class="info-bar" style="margin-bottom:12px">' +
            'Read-only listing of every input tooltip currently registered. Hover any "i" badge ' +
            'next to an input to see this content in context. Calculators can append more via ' +
            'WTS_helpTooltips.define(id, { description, typicalRange, units, references? }).' +
            '</div>' +
            '<div style="max-height:520px;overflow:auto;border:1px solid #30363d;border-radius:6px">' +
            '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
            '<thead style="background:#161b22;color:#8b949e;text-transform:uppercase;font-size:11px">' +
            '<tr>' +
            '<th style="padding:6px 8px;text-align:left">Input ID</th>' +
            '<th style="padding:6px 8px;text-align:left">Description</th>' +
            '<th style="padding:6px 8px;text-align:left">Typical</th>' +
            '<th style="padding:6px 8px;text-align:left">Units</th>' +
            '<th style="padding:6px 8px;text-align:left">Reference</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<div style="margin-top:10px;color:#8b949e;font-size:11px">' +
            'Tip: refresh() re-injects icons after the page re-renders; an observer does this ' +
            'automatically when new inputs appear in the DOM.' +
            '</div>' +
            '</div>';
    }

    // ───────────────────────────────────────────────────────────────
    // Auto-init when DOM is ready (browser only)
    // ───────────────────────────────────────────────────────────────
    function _onReady(fn) {
        if (!_hasDoc) return;
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(fn, 0);
        } else if (document.addEventListener) {
            document.addEventListener('DOMContentLoaded', fn);
        }
    }
    _onReady(function () {
        try {
            _injectStyles();
            _ensureLayer();
            _bindLayerHover();
            _installObserver();
            refresh();
        } catch (e) { _warn('tooltip auto-init failed', e); }
    });

    // PRiSM re-renders tabs, panels and steps in place: re-scan right after
    // each render (C7 tab hook, merge pattern) and on the shared events.
    function _safeRefresh() { try { refresh(); } catch (e) { _warn('tooltip refresh failed', e); } }
    (function _hookPRiSM() {
        if (!_hasWin) return;
        try {
            G.PRiSM_tabHooks = G.PRiSM_tabHooks || {};
            var any = G.PRiSM_tabHooks.any = G.PRiSM_tabHooks.any || [];
            if (any.indexOf(_safeRefresh) === -1) any.push(_safeRefresh);
        } catch (e) {}
        if (typeof G.addEventListener === 'function') {
            ['prism:tab-open', 'prism:step-changed', 'prism:well-changed', 'prism:fit-updated'].forEach(function (ev) {
                try { G.addEventListener(ev, _scheduleRefresh); } catch (e) {}
            });
        }
    })();

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_helpTooltips = {
        define:     define,
        defineMany: defineMany,
        refresh:    refresh,
        show:       show,
        hide:       hide,
        list:       list
    };
    G.WTS_renderHelpTooltipsManager = renderHelpTooltipsManager;

    // === SELF-TEST ===
    (function () {
        try {
            var checks = [];

            checks.push({ n: 'public API present',
                          ok: typeof G.WTS_helpTooltips === 'object' &&
                              typeof G.WTS_helpTooltips.define === 'function' &&
                              typeof G.WTS_helpTooltips.refresh === 'function' &&
                              typeof G.WTS_helpTooltips.show === 'function' &&
                              typeof G.WTS_helpTooltips.hide === 'function' });

            var initialCount = G.WTS_helpTooltips.list().length;
            checks.push({ n: 'manifest auto-registered (>= 50 entries)',
                          ok: initialCount >= 50 });

            G.WTS_helpTooltips.define('__selftest_id__', {
                description: 'self-test entry',
                typicalRange: '0 – 1',
                units: 'unit',
                references: ['ref-a', 'ref-b']
            });
            checks.push({ n: 'define() adds entry',
                          ok: G.WTS_helpTooltips.list().indexOf('__selftest_id__') !== -1 });

            // defineMany count
            var added = G.WTS_helpTooltips.defineMany({
                '__selftest_a__': { description: 'a', typicalRange: '1', units: 'x' },
                '__selftest_b__': { description: 'b', typicalRange: '2', units: 'y' }
            });
            checks.push({ n: 'defineMany returns count',
                          ok: added === 2 });

            // ignore bad input
            var bad1 = G.WTS_helpTooltips.define('', { description: 'x' });
            var bad2 = G.WTS_helpTooltips.define(null, { description: 'x' });
            checks.push({ n: 'define rejects bad id', ok: bad1 === false && bad2 === false });

            // show / hide are no-throw under the smoke-test stub DOM
            var didThrow = false;
            try { G.WTS_helpTooltips.show('__selftest_id__'); G.WTS_helpTooltips.hide(); }
            catch (e) { didThrow = true; }
            checks.push({ n: 'show()/hide() do not throw', ok: !didThrow });

            // show on unknown id returns false without throwing
            var unkn = G.WTS_helpTooltips.show('__doesnotexist__');
            checks.push({ n: 'show(unknown) returns false', ok: unkn === false });

            // refresh runs without throwing
            var refreshThrew = false;
            try { G.WTS_helpTooltips.refresh(); } catch (e) { refreshThrew = true; }
            checks.push({ n: 'refresh() does not throw', ok: !refreshThrew });

            // renderHelpTooltipsManager handles null gracefully
            var mgrThrew = false;
            try { G.WTS_renderHelpTooltipsManager(null); } catch (e) { mgrThrew = true; }
            checks.push({ n: 'manager handles null container', ok: !mgrThrew });

            // Specific commonly-used IDs must be in the manifest
            var keyIds = ['gasSG', 'oilAPI', 'wellheadPressure', 'esdResponseTime',
                          'sandProduction', 'salamaConstant', 'hiPilotSetting', 'skin',
                          'wellboreStorage', 'prism_well_pi', 'prism_well_tp', 'prism_well_q',
                          'prism_well_ct', 'prism_sl_method', 'prism_match_logPM', 'prism_help_FE'];
            checks.push({ n: 'PRiSM entries carry plain-language titles',
                          ok: _titleFor('prism_well_pi') === 'Initial reservoir pressure' &&
                              _titleFor('prism_help_dpS') === 'Pressure drop due to skin' });
            checks.push({ n: 'untitled ids get a readable heading',
                          ok: _titleFor('__selftest_a__') !== '__selftest_a__' });
            checks.push({ n: 'text bindings find the semilog rows',
                          ok: RESULT_ROWS.some(function (r) { return r[0].test('Flow efficiency FE') && r[1] === 'prism_help_FE'; }) });
            var allKeyPresent = true;
            for (var i = 0; i < keyIds.length; i++) {
                if (G.WTS_helpTooltips.list().indexOf(keyIds[i]) === -1) {
                    allKeyPresent = false;
                    _warn('missing manifest id:', keyIds[i]);
                }
            }
            checks.push({ n: 'all key manifest IDs present', ok: allKeyPresent });

            G.WTS_helpTooltips_selfTestResults = {
                checks: checks,
                initialCount: initialCount
            };

            var fails = checks.filter(function (c) { return !c.ok; });
            if (fails.length) _err('Help Tooltips self-test FAILED:', fails);
            else _log('✓ Help Tooltips self-test passed (' + checks.length + ' checks, ' +
                      initialCount + ' manifest entries).');
        } catch (e) {
            _err('Help Tooltips self-test threw:', e && e.message ? e.message : e);
        }
    })();

})();
