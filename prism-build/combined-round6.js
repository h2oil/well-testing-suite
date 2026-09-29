
// ═══════════════════════════════════════════════════════════════════════
// Round-6 (feature layer) — auto-injected
//   • 28-help-tooltips   (ⓘ hover-help on every tagged input + 61 entries)
//   • 29-project-save    (.h2oilproj project file save/load across modules)
//   • 30-quick-report    (one-click cross-suite PDF report)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 28-help-tooltips ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
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

})();

// ─── END 28-help-tooltips ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 29-project-save ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 29 — Cross-Module Project Save / Load (.h2oilproj)
//
// PURPOSE
//   Capture EVERY calculator's state in a single JSON file so a user can
//   close the browser tab and pick up exactly where they left off.
//   The file format is a thin wrapper around a `modules` map: each
//   calculator registers a {read, write} pair, and save/load iterate
//   over the registry.
//
//   Default registrations cover WTS, ESD Hi-Pilot, ESD Lo-Pilot,
//   Hydrate Management, Liquid Line, Pipe Service Life, PRiSM, PVT,
//   the global units toggle (PRiSM is three modules applied in the order
//   pvt → prism_dataset → prism: well & fluid inputs with provenance, the
//   dataset, then model / params / freeze / fit / type-curve match /
//   straight-line / mode / crop; New resets all three), and — the one that carries almost all of
//   the user's typed values — `storage`: a raw snapshot of every
//   localStorage key starting with `wts_` or `h2oil_` (legacy per-
//   calculator keys, the host's universal wts_page_<page> autosave
//   records, h2oil_client_info, PRiSM keys). Preference keys (unit
//   system, sample-suppress, consent/analytics flags) are never saved,
//   loaded or cleared.
//
// PUBLIC API
//   window.WTS_project = {
//       save(filename?)         → Promise<{ blob, filename, payload }>
//       saveDownload(filename?) → download (or iOS share-sheet) the file
//       saveAs()                → real "Save As" dialog where the File
//                                 System Access API exists (remembers the
//                                 file handle), else prompt + download
//       saveCurrent()           → silent write to the remembered handle,
//                                 else falls back to saveAs / download
//       open(fileInput?)        → showOpenFilePicker where available, else
//                                 clicks the given <input type=file>
//       load(file: File)        → Promise<{ loaded: [...], skipped: [...] }>
//       loadFromObject(obj)     → synchronous; same shape as load result
//       new()                   → wipe project state (keeps preferences)
//       currentFile()           → { name, hasHandle } | null
//       info()                  → { modules: [...], modifiedAt, size }
//       registerModule(name, { read, write })
//       unregisterModule(name)
//       listModules()
//   };
//   window.WTS_renderProjectToolbar(container) → mounts the File toolbar
//
// HOST HOOKS (well-testing-app.html, all optional)
//   window.WTS_pageAutosave.flush() — push the visible page's live values
//                                     into localStorage before a save
//   window.WTS_rerender({discardPending}) — repaint the current page from
//                                     storage after Open / New
//   window.__projectSaveOverride(filename, jsonText) — iOS bridge: write +
//                                     share-sheet instead of <a download>
//   'wts:autosaved' event            — drives the "● Autosaved hh:mm" status
//
// EVENTS (document)
//   'wts:project-loaded' {loaded, skipped} — after Open replaced storage
//   'wts:project-new'    {cleared}         — after New cleared storage
//   'wts:projectfile'    {name, hasHandle} — current file name changed
//   Layers that cache localStorage in memory should re-read on these.
//
// FILE FORMAT (.h2oilproj — JSON)
//   {
//     "format":   "h2oilproj",
//     "version":  "1.0",
//     "generator":"H2Oil Well Testing Suite",
//     "savedAt":  "2026-04-28T12:34:56.789Z",
//     "modules":  { "<key>": <state>, ..., "storage": { keys: {k: raw}, skipped: [] } },
//     "meta":     { client?, well?, field?, notes? }
//   }
//   Files written before the `storage` module existed still load (the
//   other modules apply; nothing in localStorage is cleared).
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'
//   • No external runtime deps — vanilla JS + Blob + FileReader
//   • Modules auto-register on load if their window globals exist; if
//     they don't, save/load just skips them (forward-compatible)
//   • Defensive: never throws on bad data — always returns / rejects
//     with a structured error
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _log()  { if (typeof console !== 'undefined' && console.log)  try { console.log.apply(console, arguments); }  catch (e) {} }
    function _warn() { if (typeof console !== 'undefined' && console.warn) try { console.warn.apply(console, arguments); } catch (e) {} }
    function _err()  { if (typeof console !== 'undefined' && console.error) try { console.error.apply(console, arguments); } catch (e) {} }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Deep clone via JSON round-trip — keeps state isolated from
    // module internals so callers can mutate without surprise.
    function _clone(v) {
        if (v == null) return v;
        try { return JSON.parse(JSON.stringify(v)); }
        catch (e) { return null; }
    }

    function _nowISO() { return new Date().toISOString(); }

    function _slugify(s) {
        return String(s == null ? 'project' : s)
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 60) || 'project';
    }

    var EXT = '.h2oilproj';

    // Keep the user's spelling/case, drop characters no file system accepts.
    function _fileName(base) {
        var s = String(base == null ? '' : base).trim().replace(/\.h2oilproj$/i, '');
        s = s.replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').substring(0, 80);
        return (s || 'project') + EXT;
    }

    function _isIOSApp() {
        if (!_hasWin) return false;
        if (G.isIOSApp === true) return true;
        try { return !!(G.Capacitor && G.Capacitor.isNativePlatform && G.Capacitor.isNativePlatform()); }
        catch (e) { return false; }
    }

    // ───────────────────────────────────────────────────────────────
    // localStorage helpers (storage module + New)
    // ───────────────────────────────────────────────────────────────
    var KEY_PREFIXES = ['wts_', 'h2oil_'];
    // Preferences / install flags — describe the user or the device, not
    // the project: never saved into a file, never overwritten or cleared.
    var PREF_KEYS = {
        'wts_unit_system': 1,            // 22-units.js STORAGE_KEY
        'wts_prism_sample_suppress': 1,  // PRiSM "don't re-seed sample data"
        'wts_prism_migrated': 1          // one-shot DCA/PTA → PRiSM migration flag
    };
    // wts_ui_*: navigation preferences (favourites, recently used, collapsed sidebar groups).
    var PREF_RE = /consent|analytics|tracking|(^|_)ga(_|$)|subscri|entitle|purchase|^wts_ui_/i;
    // Cross-project libraries: saved in the file, restored on Open only
    // when missing locally, kept on New.
    var LIBRARY_RE = /^wts_prism_(user_curves|presets|mapping_)/;
    // "Prepared by" fields of Client & Well Info survive New.
    var PREPARER_FIELDS = ['engineer', 'position', 'company', 'eng_email'];
    var MAX_KEY_CHARS = 2 * 1024 * 1024;   // skip transient blobs bigger than ~2 MB

    function _ls() {
        try {
            var ls = (typeof localStorage !== 'undefined') ? localStorage : (G.localStorage || null);
            return (ls && typeof ls.getItem === 'function') ? ls : null;
        } catch (e) { return null; }
    }
    function _lsKeys(ls) {
        var out = [];
        if (!ls) return out;
        try {
            if (typeof ls.key === 'function' && typeof ls.length === 'number') {
                for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k != null) out.push(k); }
            } else if (ls._ && typeof ls._ === 'object') {       // smoke-test stub
                out = Object.keys(ls._);
            }
        } catch (e) {}
        return out;
    }
    function _hasPrefix(k) {
        for (var i = 0; i < KEY_PREFIXES.length; i++) if (String(k).indexOf(KEY_PREFIXES[i]) === 0) return true;
        return false;
    }
    function _isPrefKey(k)    { return !!PREF_KEYS[k] || PREF_RE.test(String(k)); }
    function _isLibraryKey(k) { return LIBRARY_RE.test(String(k)); }
    function _isProjectKey(k) { return _hasPrefix(k) && !_isPrefKey(k); }

    function _readClientInfo() {
        var ls = _ls();
        try { return JSON.parse((ls && ls.getItem('h2oil_client_info')) || '{}') || {}; }
        catch (e) { return {}; }
    }

    // Remove every project key (keeps preferences + libraries). Keeps the
    // "Report prepared by" part of Client & Well Info.
    function _clearProjectKeys() {
        var ls = _ls();
        if (!ls) return [];
        var ci = _readClientInfo();
        var removed = [];
        var keys = _lsKeys(ls);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (!_isProjectKey(k) || _isLibraryKey(k)) continue;
            try { ls.removeItem(k); removed.push(k); } catch (e) {}
        }
        var keep = {}, any = false;
        for (var j = 0; j < PREPARER_FIELDS.length; j++) {
            var f = PREPARER_FIELDS[j];
            if (ci[f]) { keep[f] = ci[f]; any = true; }
        }
        if (any) { try { ls.setItem('h2oil_client_info', JSON.stringify(keep)); } catch (e) {} }
        return removed;
    }

    function _flushAutosave() {
        try {
            if (G.WTS_pageAutosave && typeof G.WTS_pageAutosave.flush === 'function') G.WTS_pageAutosave.flush();
        } catch (e) { _warn('[WTS_project] autosave flush failed', e); }
    }

    // Repaint the visible page from storage (host hook) — after Open / New.
    function _rerender() {
        try {
            if (typeof G.WTS_rerender === 'function') G.WTS_rerender({ discardPending: true });
        } catch (e) { _warn('[WTS_project] re-render failed', e); }
    }

    // ───────────────────────────────────────────────────────────────
    // Module registry
    //
    //   MODULES[key] = {
    //     read:  () => state object (or null)
    //     write: (state) => void
    //   }
    //
    // Each module owns persistence of its OWN namespace. The project
    // layer only orchestrates and serialises.
    // ───────────────────────────────────────────────────────────────
    var MODULES = {};

    function registerModule(key, handler) {
        if (!key || typeof key !== 'string') return false;
        if (!handler || typeof handler.read !== 'function' ||
            typeof handler.write !== 'function') return false;
        MODULES[key] = handler;
        return true;
    }
    function unregisterModule(key) {
        if (MODULES[key]) { delete MODULES[key]; return true; }
        return false;
    }
    function listModules() {
        var out = [];
        for (var k in MODULES) if (Object.prototype.hasOwnProperty.call(MODULES, k)) out.push(k);
        return out;
    }

    // ───────────────────────────────────────────────────────────────
    // Default module registrations
    //
    // Each handler is registered defensively — they read from / write
    // to the canonical globals used by layers 22-27 + PRiSM. If a
    // global isn't there at save-time, the handler returns null and
    // the module is skipped in the output file.
    // ───────────────────────────────────────────────────────────────
    function _ensureWTSState() {
        if (!G.WTS_state || typeof G.WTS_state !== 'object') G.WTS_state = {};
        return G.WTS_state;
    }

    // ───────────────────────────────────────────────────────────────
    // PRiSM state helpers (analysis state, dataset, well store)
    //
    // Saved from window.PRiSM_state: the persisted analysis fields (C8)
    // plus interpretation, model race, saved fits, rail pins and period
    // flags; other plain JSON fields ride along under `extra`. Derived or
    // library fields (model curves, presets) and the legacy `match` are not
    // saved. Shell state: PRiSM.mode / tab / multiRate. Crop window from
    // window.PRiSM_cropState. Legacy files (`activeModel`) still load.
    // ───────────────────────────────────────────────────────────────
    var PRISM_KEYS = ['model', 'params', 'paramFreeze', 'phys', 'tcMatch', 'activePlot', 'activePeriod',
                      'bourdetL', 'timeFn', 'lastFit', 'semilog', 'analysisKeyResults', 'interp',
                      'autoMatch', 'fits', 'reportPins', 'periodFlags'];
    var PRISM_SKIP = { presets: 1, match: 1, modelCurve: 1, modelCurveData: 1, autoMatchStatus: 1,
                       project: 1, activeModel: 1, autoMatchTopN: 1, pvt: 1, crop: 1 };
    var EXTRA_MAX_CHARS = 200000;
    // Fresh analysis state as the UI layer created it (captured when this
    // layer loads, before any restore) — used by New.
    var _PRISM_TEMPLATE = (G.PRiSM_state && typeof G.PRiSM_state === 'object') ? _clone(G.PRiSM_state) : null;

    function _own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function _isPlain(v) {
        if (v === null || typeof v !== 'object') return true;
        if (Array.isArray(v)) return true;
        var pr = Object.getPrototypeOf(v);
        return pr === Object.prototype || pr === null;
    }
    function _numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

    // Dataset copy with typed arrays turned into plain arrays (JSON-safe).
    function _plainDataset(ds) {
        if (!ds || typeof ds !== 'object') return null;
        function plain(v) {
            if (v && typeof v === 'object' && typeof v.length === 'number' && !Array.isArray(v) &&
                typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
                return Array.prototype.slice.call(v);
            }
            return v;
        }
        var out = {};
        for (var k in ds) {
            if (!_own(ds, k)) continue;
            var v = plain(ds[k]);
            if (v && typeof v === 'object' && !Array.isArray(v) && _isPlain(v)) {
                var o = {};
                for (var j in v) if (_own(v, j)) o[j] = plain(v[j]);
                v = o;
            }
            out[k] = v;
        }
        return _clone(out);
    }

    // Replace the contents of a window object in place (other layers keep
    // references to it).
    function _replaceInPlace(name, fresh) {
        var cur = G[name];
        if (!cur || typeof cur !== 'object' || cur === fresh) { G[name] = fresh; return; }
        var k;
        for (k in cur) if (_own(cur, k)) delete cur[k];
        for (k in fresh) if (_own(fresh, k)) cur[k] = fresh[k];
    }

    function _readPRiSM() {
        var st = G.PRiSM_state;
        if (!st || typeof st !== 'object') return null;
        var out = { schema: 2 };
        for (var i = 0; i < PRISM_KEYS.length; i++) {
            var key = PRISM_KEYS[i];
            if (st[key] === undefined) continue;
            out[key] = (st[key] === null) ? null : _clone(st[key]);
        }
        var extra = {}, nExtra = 0;
        for (var k in st) {
            if (!_own(st, k) || PRISM_KEYS.indexOf(k) >= 0 || PRISM_SKIP[k] || k.charAt(0) === '_') continue;
            var v = st[k];
            if (v === undefined || typeof v === 'function' || !_isPlain(v)) continue;
            var txt;
            try { txt = JSON.stringify(v); } catch (e) { continue; }
            if (txt == null || txt.length > EXTRA_MAX_CHARS) continue;
            extra[k] = JSON.parse(txt);
            nExtra++;
        }
        if (nExtra) out.extra = extra;
        var P = G.PRiSM;
        if (P && typeof P === 'object') {
            if (P.mode != null) out.mode = P.mode;
            if (P.tab != null) out.tab = P.tab;
            if (Array.isArray(P.multiRate)) out.multiRate = _clone(P.multiRate);
        }
        var cs = G.PRiSM_cropState;
        if (cs && typeof cs === 'object' && (cs.t_start != null || cs.t_end != null || cs.fullDataset)) {
            out.crop = { t_start: _numOrNull(cs.t_start), t_end: _numOrNull(cs.t_end),
                         i_start: _numOrNull(cs.i_start), i_end: _numOrNull(cs.i_end),
                         fullDataset: cs.fullDataset ? _plainDataset(cs.fullDataset) : null };
        }
        var ds = G.PRiSM_dataset;
        out.hasDataset = !!(ds && ds.t && ds.t.length);
        return out;
    }

    // Load: model first (through the UI layer's setter when present), then
    // parameters, then everything else; the fit is restored last.
    function _applyPRiSM(state) {
        var st = G.PRiSM_state;
        if (!st || typeof st !== 'object') st = G.PRiSM_state = {};
        var reg = G.PRiSM_MODELS || {};
        var model = (typeof state.model === 'string' && state.model) ||
                    (typeof state.activeModel === 'string' && state.activeModel) || null;
        var hasParams = !!(state.params && typeof state.params === 'object');
        if (model) {
            var viaSetter = false;
            if (reg[model] && typeof G.PRiSM_setModel === 'function') {
                try { G.PRiSM_setModel(model, { source: 'project' }); viaSetter = true; }
                catch (e) { _warn('[WTS_project] PRiSM_setModel failed', e); }
            }
            if (st.model !== model) st.model = model;
            if (!viaSetter && reg[model] && reg[model].defaults && !hasParams) {
                st.params = _clone(reg[model].defaults) || {};
            }
        }
        if (hasParams) {
            var base = (st.params && typeof st.params === 'object') ? st.params : {};
            var merged = {}, p;
            for (p in base) if (_own(base, p)) merged[p] = base[p];
            for (p in state.params) if (_own(state.params, p)) merged[p] = _clone(state.params[p]);
            st.params = merged;
        }
        if (state.paramFreeze && typeof state.paramFreeze === 'object') st.paramFreeze = _clone(state.paramFreeze);
        var later = { model: 1, params: 1, paramFreeze: 1, lastFit: 1, interp: 1 };
        for (var i = 0; i < PRISM_KEYS.length; i++) {
            var key = PRISM_KEYS[i];
            if (later[key] || !_own(state, key)) continue;
            st[key] = (state[key] === null) ? null : _clone(state[key]);
        }
        if (state.extra && typeof state.extra === 'object') {
            for (var x in state.extra) if (_own(state.extra, x) && !PRISM_SKIP[x] && PRISM_KEYS.indexOf(x) < 0) st[x] = _clone(state.extra[x]);
        }
        st.match = { timeShift: 0, pressShift: 0 };     // legacy field: never holds a fit
        if ('modelCurve' in st) st.modelCurve = null;   // derived; rebuilt by the UI
        st.lastFit = state.lastFit ? _clone(state.lastFit) : null;
        st.interp = null;
        if (st.lastFit && typeof G.PRiSM_interpretCurrentFit === 'function') {
            try { st.interp = G.PRiSM_interpretCurrentFit() || null; } catch (e) { st.interp = null; }
        }
        if (!st.interp && state.interp) st.interp = _clone(state.interp);
        // Shell state
        if (!G.PRiSM || typeof G.PRiSM !== 'object') G.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
        if (['transient', 'decline', 'combined'].indexOf(state.mode) >= 0) G.PRiSM.mode = state.mode;
        var tab = parseInt(state.tab, 10);
        if (tab >= 1 && tab <= 7) G.PRiSM.tab = tab;
        if (Array.isArray(state.multiRate)) G.PRiSM.multiRate = _clone(state.multiRate) || [];
        var cs = G.PRiSM_cropState;
        if (cs && typeof cs === 'object') {
            var cr = (state.crop && typeof state.crop === 'object' && 't_start' in state.crop) ? state.crop : null;
            cs.t_start = cr ? _numOrNull(cr.t_start) : null;
            cs.t_end = cr ? _numOrNull(cr.t_end) : null;
            cs.i_start = cr ? _numOrNull(cr.i_start) : null;
            cs.i_end = cr ? _numOrNull(cr.i_end) : null;
            cs.fullDataset = (cr && cr.fullDataset) ? _clone(cr.fullDataset) : null;
        }
    }

    // New: analysis state back to the UI layer's defaults (model presets kept).
    function _resetPRiSM() {
        var st = G.PRiSM_state;
        if (!st || typeof st !== 'object') st = G.PRiSM_state = {};
        var tpl = _PRISM_TEMPLATE ? _clone(_PRISM_TEMPLATE) : null;
        if (!tpl) {
            var reg = G.PRiSM_MODELS || {};
            tpl = { model: 'homogeneous', params: _clone(reg.homogeneous && reg.homogeneous.defaults) || {},
                    paramFreeze: {}, activePlot: 'bourdet' };
        }
        var k;
        for (k in st) if (_own(st, k) && k !== 'presets') delete st[k];
        for (k in tpl) if (_own(tpl, k) && k !== 'presets') st[k] = tpl[k];
        st.match = { timeShift: 0, pressShift: 0 };
        st.lastFit = null;
        st.interp = null;
        ['semilog', 'tcMatch', 'autoMatch'].forEach(function (key) { if (key in st) st[key] = null; });
        if ('activePeriod' in st) st.activePeriod = null;
        if (G.PRiSM && typeof G.PRiSM === 'object') { G.PRiSM.mode = 'transient'; G.PRiSM.tab = 1; G.PRiSM.multiRate = []; }
        var cs = G.PRiSM_cropState;
        if (cs && typeof cs === 'object') { cs.t_start = cs.t_end = cs.i_start = cs.i_end = null; cs.fullDataset = null; }
    }

    // New: well & fluid inputs back to defaults, every input marked default.
    function _resetPVT() {
        if (typeof G.PRiSM_resetWell === 'function') {
            try { G.PRiSM_resetWell({ source: 'default' }); return; } catch (e) { _warn('[WTS_project] resetWell failed', e); }
        }
        if (typeof G.PRiSM_pvt_compute !== 'function') return;
        var old = G.PRiSM_pvt, fresh = null;
        G.PRiSM_pvt = null;
        try { G.PRiSM_pvt_compute(); fresh = G.PRiSM_pvt; } catch (e) { fresh = null; }
        if (!fresh || typeof fresh !== 'object') { G.PRiSM_pvt = old; return; }
        fresh.provenance = {};
        G.PRiSM_pvt = old;
        _replaceInPlace('PRiSM_pvt', fresh);
        if (G.WTS_state && typeof G.WTS_state === 'object') G.WTS_state.pvt = null;
    }

    // After Open / New: persist the analysis state (C8) and tell the PRiSM
    // layers that inputs and results changed.
    function _prismSync(source) {
        if (!G.PRiSM_state && !G.PRiSM_pvt) return;
        try { if (typeof G.PRiSM_saveState === 'function') G.PRiSM_saveState(); } catch (e) {}
        // The well store's own debounced save may not have run before the
        // file was written: persist the restored store (same format as 16).
        var ls = _ls(), pvt = G.PRiSM_pvt;
        if (ls && pvt && typeof pvt === 'object') {
            try {
                var copy = {};
                for (var k in pvt) if (_own(pvt, k) && k !== '_computed') copy[k] = pvt[k];
                ls.setItem('wts_prism_pvt', JSON.stringify(copy));
            } catch (e) {}
        }
        _emitWin('prism:well-changed', { source: source });
        _emitWin('prism:fit-updated', { source: source, modelKey: G.PRiSM_state ? G.PRiSM_state.model : null });
    }
    function _emitWin(name, detail) {
        try {
            if (_hasWin && typeof G.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                G.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
            }
        } catch (e) {}
    }

    function _registerDefaults() {
        // wts — generic WTS flow profile state (top-level WTS_state minus the
        // per-module nested keys we register separately).
        registerModule('wts', {
            read: function () {
                if (!G.WTS_state) return null;
                var s = G.WTS_state;
                var copy = {};
                var skip = { esdHiPilot: 1, esdLoPilot: 1, hydrate: 1, liquidline: 1,
                             pipelife: 1, prism: 1, pvt: 1, units: 1, clientInfo: 1 };
                for (var k in s) {
                    if (Object.prototype.hasOwnProperty.call(s, k) && !skip[k]) {
                        copy[k] = _clone(s[k]);
                    }
                }
                return copy;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (!state || typeof state !== 'object') return;
                for (var k in state) {
                    if (Object.prototype.hasOwnProperty.call(state, k)) {
                        s[k] = _clone(state[k]);
                    }
                }
            }
        });

        registerModule('esdhi', {
            read: function () {
                return (G.WTS_state && G.WTS_state.esdHiPilot) ? _clone(G.WTS_state.esdHiPilot) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.esdHiPilot = _clone(state);
            }
        });

        registerModule('esdlo', {
            read: function () {
                return (G.WTS_state && G.WTS_state.esdLoPilot) ? _clone(G.WTS_state.esdLoPilot) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.esdLoPilot = _clone(state);
            }
        });

        registerModule('hydrate', {
            read: function () {
                return (G.WTS_state && G.WTS_state.hydrate) ? _clone(G.WTS_state.hydrate) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.hydrate = _clone(state);
            }
        });

        registerModule('liquidline', {
            read: function () {
                return (G.WTS_state && G.WTS_state.liquidline) ? _clone(G.WTS_state.liquidline) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.liquidline = _clone(state);
            }
        });

        registerModule('pipelife', {
            read: function () {
                return (G.WTS_state && G.WTS_state.pipelife) ? _clone(G.WTS_state.pipelife) : null;
            },
            write: function (state) {
                var s = _ensureWTSState();
                if (state) s.pipelife = _clone(state);
            }
        });

        // PRiSM — three modules, applied in this order on Open (registry
        // order, see _applyPayload): well & fluid inputs, then the dataset,
        // then the analysis state (model, parameters, fit, match, …).
        registerModule('pvt', {
            read: function () {
                var src = G.PRiSM_pvt || (G.WTS_state && G.WTS_state.pvt) || null;
                if (!src) return null;
                var out = _clone(src);
                if (out) delete out._computed;           // derived; recomputed on load
                return out;
            },
            write: function (state) {
                if (state === null) { _resetPVT(); return; }      // New
                if (!state || typeof state !== 'object') return;
                var fresh = _clone(state);
                if (!fresh) return;
                delete fresh._computed;
                _replaceInPlace('PRiSM_pvt', fresh);
                try { if (typeof G.PRiSM_pvt_compute === 'function') G.PRiSM_pvt_compute(); } catch (e) {}
                var s = _ensureWTSState();
                s.pvt = _clone(fresh);
            }
        });

        registerModule('prism_dataset', {
            read: function () {
                if (!G.PRiSM_dataset) return null;
                // Opt-out kept for callers that set it (datasets can be large).
                if (G.PRiSM_state && G.PRiSM_state.project &&
                    G.PRiSM_state.project.includeDataset === false) return null;
                return _plainDataset(G.PRiSM_dataset);
            },
            write: function (state) {
                if (state === null) { G.PRiSM_dataset = null; return; }   // New
                if (!state || typeof state !== 'object') return;
                G.PRiSM_dataset = _clone(state);
            }
        });

        registerModule('prism', {
            read: _readPRiSM,
            write: function (state) {
                if (state === null) { _resetPRiSM(); return; }     // New
                if (!state || typeof state !== 'object') return;
                _applyPRiSM(state);
            }
        });

        registerModule('units', {
            read: function () {
                if (G.WTS_state && G.WTS_state.units) return _clone(G.WTS_state.units);
                if (G.WTS_unitsSystem) return { system: G.WTS_unitsSystem };
                return null;
            },
            write: function (state) {
                if (!state) return;
                var s = _ensureWTSState();
                s.units = _clone(state);
                if (state.system) G.WTS_unitsSystem = state.system;
                // Let units layer re-paint if it offers a hook
                if (typeof G.WTS_setUnitsSystem === 'function' && state.system) {
                    try { G.WTS_setUnitsSystem(state.system); } catch (e) {}
                }
            }
        });

        registerModule('clientinfo', {
            read: function () {
                if (G.WTS_state && G.WTS_state.clientInfo) return _clone(G.WTS_state.clientInfo);
                return null;
            },
            write: function (state) {
                if (!state) return;
                var s = _ensureWTSState();
                s.clientInfo = _clone(state);
            }
        });

        // storage — every user-typed value on every page. Raw localStorage
        // strings for keys prefixed wts_ / h2oil_ (minus preferences).
        //   read()      flushes the visible page first, skips values > 2 MB
        //   write(obj)  replaces the project keys with the file's keys
        //   write(null) clears the project keys (New)
        registerModule('storage', {
            read: function () {
                _flushAutosave();
                var ls = _ls();
                if (!ls) return null;
                var keys = _lsKeys(ls).filter(_isProjectKey).sort();
                var out = {}, skipped = [], n = 0;
                for (var i = 0; i < keys.length; i++) {
                    var v = null;
                    try { v = ls.getItem(keys[i]); } catch (e) { v = null; }
                    if (v == null) continue;
                    if (v.length > MAX_KEY_CHARS) {
                        skipped.push({ key: keys[i], chars: v.length });
                        continue;
                    }
                    out[keys[i]] = String(v);
                    n++;
                }
                if (skipped.length) {
                    _warn('[WTS_project] storage: skipped ' + skipped.length +
                          ' oversized key(s) (> 2 MB):', skipped);
                }
                return n ? { keys: out, skipped: skipped } : null;
            },
            write: function (state) {
                var ls = _ls();
                if (!ls) return;
                if (state === null) { _clearProjectKeys(); return; }        // New
                if (!state || typeof state !== 'object' || !state.keys ||
                    typeof state.keys !== 'object') return;
                _clearProjectKeys();
                var keys = state.keys;
                for (var k in keys) {
                    if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
                    if (!_isProjectKey(k) || typeof keys[k] !== 'string') continue;
                    if (_isLibraryKey(k) && ls.getItem(k) != null) continue;  // keep local library
                    try { ls.setItem(k, keys[k]); }
                    catch (e) { _warn('[WTS_project] storage: could not write ' + k, e); }
                }
            }
        });
    }
    _registerDefaults();

    // Report metadata from Client & Well Info (used for the file name).
    function _defaultMeta() {
        var ci = _readClientInfo(), m = {};
        if (ci.client) m.client = String(ci.client);
        if (ci.well) m.well = String(ci.well);
        if (ci.field) m.field = String(ci.field);
        if (ci.operator) m.operator = String(ci.operator);
        return m;
    }
    function _suggestedName() {
        if (_current.name) return _current.name;
        var well = '';
        try {
            well = _readClientInfo().well ||
                   (G.WTS_state && G.WTS_state.clientInfo && G.WTS_state.clientInfo.wellName) || '';
        } catch (e) {}
        return _fileName(well || 'project');
    }

    // ───────────────────────────────────────────────────────────────
    // Build the file payload by polling every registered module
    // ───────────────────────────────────────────────────────────────
    function _buildPayload(meta) {
        var modules = {};
        for (var k in MODULES) {
            if (!Object.prototype.hasOwnProperty.call(MODULES, k)) continue;
            var state = null;
            try { state = MODULES[k].read(); } catch (e) {
                _warn('module read failed for ' + k, e);
                state = null;
            }
            if (state != null) modules[k] = state;
        }
        var payload = {
            format:    'h2oilproj',
            version:   '1.0',
            generator: 'H2Oil Well Testing Suite',
            savedAt:   _nowISO(),
            meta:      meta || _defaultMeta(),
            modules:   modules
        };
        return payload;
    }

    function _applyPayload(payload) {
        var loaded = [];
        var skipped = [];
        if (!payload || typeof payload !== 'object') {
            return { loaded: loaded, skipped: skipped, error: 'empty payload' };
        }
        if (payload.format && payload.format !== 'h2oilproj') {
            return { loaded: loaded, skipped: skipped, error: 'wrong format: ' + payload.format };
        }
        // Drop pending debounced autosaves so they can't overwrite loaded keys.
        try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.cancel) G.WTS_pageAutosave.cancel(); } catch (e) {}
        var mods = payload.modules || {};
        // A project with PRiSM state but no dataset must not inherit the
        // dataset that is open now (it is re-read from the restored inputs).
        if (_own(mods, 'prism') && !_own(mods, 'prism_dataset')) G.PRiSM_dataset = null;
        // Apply in registry order (inputs → dataset → analysis → storage), not
        // in the file's key order, so dependent modules see their inputs.
        var order = listModules();
        for (var k in mods) if (_own(mods, k) && order.indexOf(k) === -1) skipped.push(k);
        for (var i = 0; i < order.length; i++) {
            var key = order[i];
            if (!_own(mods, key)) continue;
            try {
                MODULES[key].write(mods[key]);
                loaded.push(key);
            } catch (e) {
                _warn('module write failed for ' + key, e);
                skipped.push(key);
            }
        }
        return { loaded: loaded, skipped: skipped, error: null };
    }

    // ───────────────────────────────────────────────────────────────
    // Save — returns a Promise<{ blob, filename, payload, json }>
    // ───────────────────────────────────────────────────────────────
    function _saveSync(filename, meta) {
        var payload = _buildPayload(meta);
        var json = JSON.stringify(payload, null, 2);
        var blob = null;
        if (typeof G.Blob === 'function') {
            try { blob = new G.Blob([json], { type: 'application/json' }); }
            catch (e) { blob = null; }
        }
        var name = filename ? _fileName(filename) : _suggestedName();
        // In node (smoke-test) Blob won't exist — fall back to a stub object.
        if (!blob || typeof blob.size !== 'number') blob = { size: json.length, type: 'application/json', _text: json };
        return { blob: blob, filename: name, payload: payload, json: json };
    }

    function save(filename, meta) {
        try {
            var res = _saveSync(filename, meta);
            if (typeof G.Promise === 'function') return G.Promise.resolve(res);
            return res;
        } catch (e) {
            _err('save() failed', e);
            if (typeof G.Promise === 'function') return G.Promise.reject(e);
            throw e;
        }
    }

    // Anchor download (desktop browsers without the File System Access API).
    function _download(res) {
        if (!_hasDoc) return false;
        try {
            var url = (G.URL && typeof G.URL.createObjectURL === 'function' && res.blob && !res.blob._text)
                ? G.URL.createObjectURL(res.blob) : null;
            var a = document.createElement('a');
            a.href = url || ('data:application/json;charset=utf-8,' + encodeURIComponent(res.json));
            a.download = res.filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                try { document.body.removeChild(a); } catch (e) {}
                if (url && G.URL && G.URL.revokeObjectURL) {
                    try { G.URL.revokeObjectURL(url); } catch (e) {}
                }
            }, 250);
            return true;
        } catch (e) { _warn('download could not click', e); return false; }
    }

    // Deliver a built file: iOS override (write + share sheet) or download.
    function _deliver(res) {
        if (typeof G.__projectSaveOverride === 'function') {
            return G.Promise.resolve()
                .then(function () { return G.__projectSaveOverride(res.filename, res.json); })
                .then(function (ok) {
                    if (ok === false) { _download(res); res.method = 'download'; }
                    else res.method = 'override';
                    return res;
                }, function (e) {
                    _warn('[WTS_project] save override failed, downloading instead', e);
                    _download(res); res.method = 'download';
                    return res;
                });
        }
        _download(res);
        res.method = 'download';
        return G.Promise.resolve(res);
    }

    // ───────────────────────────────────────────────────────────────
    // saveDownload — build + deliver (download / iOS share sheet)
    // ───────────────────────────────────────────────────────────────
    function saveDownload(filename, meta) {
        try {
            var res = _saveSync(filename, meta);
            if (!_hasDoc) return (typeof G.Promise === 'function') ? G.Promise.resolve(res) : res;
            return _deliver(res);
        } catch (e) { _err('saveDownload failed', e); throw e; }
    }

    // ───────────────────────────────────────────────────────────────
    // Save / Save As with a remembered file (File System Access API)
    // ───────────────────────────────────────────────────────────────
    var _current = { handle: null, name: null };
    var PICKER_TYPES = [{ description: 'H2Oil project', accept: { 'application/json': [EXT] } }];

    function _hasSavePicker() {
        return _hasWin && typeof G.showSaveFilePicker === 'function' &&
               typeof G.__projectSaveOverride !== 'function';
    }
    function _hasOpenPicker() {
        return _hasWin && typeof G.showOpenFilePicker === 'function' && !_isIOSApp();
    }
    function _notifyFile() {
        try {
            if (_hasDoc && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('wts:projectfile', { detail: currentFile() }));
            }
        } catch (e) {}
    }
    function _setCurrent(handle, name) {
        _current = { handle: handle || null, name: name || null };
        _notifyFile();
    }
    function currentFile() {
        return _current.name ? { name: _current.name, hasHandle: !!_current.handle } : null;
    }

    function _writeHandle(handle, text) {
        return G.Promise.resolve()
            .then(function () {
                if (typeof handle.queryPermission !== 'function') return;
                return handle.queryPermission({ mode: 'readwrite' }).then(function (st) {
                    if (st === 'granted' || typeof handle.requestPermission !== 'function') return;
                    return handle.requestPermission({ mode: 'readwrite' }).then(function (st2) {
                        if (st2 !== 'granted') throw new Error('write permission denied');
                    });
                });
            })
            .then(function () { return handle.createWritable(); })
            .then(function (w) { return G.Promise.resolve(w.write(text)).then(function () { return w.close(); }); });
    }

    // Download fallback for Save As — ask for a name first.
    function _downloadAs(res, askName) {
        var name = res.filename;
        if (askName && typeof G.prompt === 'function') {
            var nm = G.prompt('Save project as…', name.replace(/\.h2oilproj$/i, ''));
            if (nm == null || !String(nm).trim()) return G.Promise.resolve({ cancelled: true });
            name = _fileName(nm);
        }
        res.filename = name;
        return _deliver(res).then(function (r) {
            _setCurrent(null, name);
            return { saved: true, filename: name, method: r.method };
        });
    }

    function saveAs() {
        var res;
        try { res = _saveSync(null); } catch (e) { return G.Promise.reject(e); }
        if (_hasSavePicker()) {
            var picked;
            try {
                picked = G.showSaveFilePicker({ suggestedName: res.filename, types: PICKER_TYPES });
            } catch (e) { picked = G.Promise.reject(e); }
            return G.Promise.resolve(picked).then(function (handle) {
                return _writeHandle(handle, res.json).then(function () {
                    _setCurrent(handle, handle.name || res.filename);
                    return { saved: true, filename: _current.name, method: 'picker' };
                });
            }, function (e) {
                if (e && e.name === 'AbortError') return { cancelled: true };
                _warn('[WTS_project] save dialog unavailable, downloading instead', e);
                return _downloadAs(res, true);
            });
        }
        return _downloadAs(res, true);
    }

    function saveCurrent() {
        // First Save with a dialog-capable browser = Save As (must run in the click's activation)
        if (!_current.handle && _hasSavePicker()) return saveAs();
        var res;
        try { res = _saveSync(null); } catch (e) { return G.Promise.reject(e); }
        if (_current.handle) {
            var h = _current.handle;
            return _writeHandle(h, res.json).then(function () {
                _notifyFile();
                return { saved: true, filename: _current.name, method: 'handle' };
            }, function (e) {
                _warn('[WTS_project] could not write ' + _current.name + ' — choosing a new file', e);
                return saveAs();
            });
        }
        return _downloadAs(res, false);              // no dialog API: download / share silently
    }

    // Open: native picker (remembers the handle so Save overwrites it) or
    // the hidden <input type=file>. Returns a Promise; with the <input>
    // path it resolves { deferred: true } and the input's change handler
    // does the load.
    function open(fileInput) {
        function viaInput() {
            if (!fileInput || typeof fileInput.click !== 'function') {
                return G.Promise.reject(new Error('no file picker available'));
            }
            try {
                // iOS greys out unknown extensions (.h2oilproj has no UTI) — accept anything there.
                if (_isIOSApp()) fileInput.removeAttribute('accept');
                else fileInput.setAttribute('accept', EXT + ',.json,application/json');
            } catch (e) {}
            fileInput.click();
            return G.Promise.resolve({ deferred: true });
        }
        if (!_hasOpenPicker()) return viaInput();
        var picked;
        try {
            picked = G.showOpenFilePicker({ multiple: false, types: [{ description: 'H2Oil project',
                     accept: { 'application/json': [EXT, '.json'] } }] });
        } catch (e) { picked = G.Promise.reject(e); }
        return G.Promise.resolve(picked).then(function (handles) {
            var h = handles && handles[0];
            if (!h) return { cancelled: true };
            return h.getFile().then(function (file) {
                return load(file).then(function (r) {
                    if (r && !r.error) _setCurrent(h, file.name);
                    if (r) r.filename = file.name;
                    return r;
                });
            });
        }, function (e) {
            if (e && e.name === 'AbortError') return { cancelled: true };
            _warn('[WTS_project] open dialog unavailable, using file input', e);
            return viaInput();
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Load — accept a File (browser) or string (smoke-test)
    // ───────────────────────────────────────────────────────────────
    function load(file) {
        if (!file) {
            if (typeof G.Promise === 'function') return G.Promise.reject(new Error('no file'));
            throw new Error('no file');
        }
        // string -> parse directly
        if (typeof file === 'string') {
            return new G.Promise(function (resolve, reject) {
                try { resolve(loadFromObject(JSON.parse(file))); }
                catch (e) { reject(e); }
            });
        }
        // Plain object (e.g. parsed JSON passed in)
        if (typeof file === 'object' && file && !file.text && !file.arrayBuffer &&
            !file.name && !file._text) {
            if (typeof G.Promise === 'function') return G.Promise.resolve(loadFromObject(file));
            return loadFromObject(file);
        }
        // File / Blob from <input type=file>
        var readerCtor = G.FileReader;
        if (!readerCtor) {
            // Some environments lack FileReader; try .text()
            if (typeof file.text === 'function') {
                return file.text().then(function (txt) {
                    return loadFromObject(JSON.parse(txt));
                });
            }
            return G.Promise.reject(new Error('FileReader unavailable'));
        }
        return new G.Promise(function (resolve, reject) {
            try {
                var fr = new readerCtor();
                fr.onload = function () {
                    try {
                        var txt = (fr.result == null) ? '' : String(fr.result);
                        var obj = JSON.parse(txt);
                        resolve(loadFromObject(obj));
                    } catch (e) { reject(e); }
                };
                fr.onerror = function () { reject(fr.error || new Error('read error')); };
                fr.readAsText(file);
            } catch (e) { reject(e); }
        });
    }

    // Tell other layers (caches kept in memory) that storage was replaced.
    function _emit(name, detail) {
        try {
            if (_hasDoc && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
            }
        } catch (e) {}
    }

    function loadFromObject(obj) {
        var res = _applyPayload(obj);
        if (res && !res.error && res.loaded.length) {
            var touched = ['prism', 'prism_dataset', 'pvt', 'storage'].some(function (m) { return res.loaded.indexOf(m) !== -1; });
            if (touched) _prismSync('project-load');
            _emit('wts:project-loaded', { loaded: res.loaded.slice(), skipped: res.skipped.slice() });
            _rerender();
        }
        return res;
    }

    // ───────────────────────────────────────────────────────────────
    // New — clear every registered module's state + project keys in
    // localStorage (preferences / libraries / "prepared by" are kept)
    // ───────────────────────────────────────────────────────────────
    function newProject() {
        try { if (G.WTS_pageAutosave && G.WTS_pageAutosave.cancel) G.WTS_pageAutosave.cancel(); } catch (e) {}
        var cleared = [];
        for (var k in MODULES) {
            if (!Object.prototype.hasOwnProperty.call(MODULES, k)) continue;
            try {
                MODULES[k].write(null);
                cleared.push(k);
            } catch (e) { _warn('clear failed for ' + k, e); }
        }
        // Reset WTS_state to a blank object for non-module keys too.
        try { G.WTS_state = {}; } catch (e) {}
        // In-memory row models that outlive a page render.
        try { if (Array.isArray(G._genMotors)) G._genMotors = []; } catch (e) {}
        _prismSync('project-new');
        _setCurrent(null, null);
        _emit('wts:project-new', { cleared: cleared.slice() });
        _rerender();
        return { cleared: cleared };
    }

    // ───────────────────────────────────────────────────────────────
    // Info — describe the current in-memory project
    // ───────────────────────────────────────────────────────────────
    function info() {
        var modulesWithState = [];
        var modulesEmpty = [];
        for (var k in MODULES) {
            if (!Object.prototype.hasOwnProperty.call(MODULES, k)) continue;
            var st = null;
            try { st = MODULES[k].read(); } catch (e) {}
            if (st != null) modulesWithState.push(k);
            else modulesEmpty.push(k);
        }
        var payload = _buildPayload();
        var size = 0;
        try { size = JSON.stringify(payload).length; } catch (e) {}
        return {
            modules:           modulesWithState,
            emptyModules:      modulesEmpty,
            registeredModules: listModules(),
            modifiedAt:        payload.savedAt,
            size:              size,
            file:              currentFile()
        };
    }

    // ───────────────────────────────────────────────────────────────
    // File toolbar UI — New | Open | Save | Save As  + status
    // ───────────────────────────────────────────────────────────────
    function _hhmm(t) {
        var d = new Date(t);
        var h = d.getHours(), m = d.getMinutes();
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    function renderProjectToolbar(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;

        // Idempotent — do not duplicate if already mounted in the host.
        var existing = (container.querySelector)
            ? container.querySelector('[data-wts-project-toolbar="1"]') : null;
        if (existing) return;

        var wrap = document.createElement('div');
        wrap.setAttribute('data-wts-project-toolbar', '1');
        wrap.style.cssText =
            'display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--bg2,#161b22);' +
            'border:1px solid var(--border,#30363d);border-radius:6px;font-size:12px;' +
            'color:var(--text2,#8b949e);flex-wrap:wrap';

        var btnStyle =
            'padding:4px 10px;background:var(--bg4,#21262d);border:1px solid var(--border,#30363d);' +
            'border-radius:4px;color:var(--text,#e6edf3);font-size:12px;cursor:pointer;line-height:1.4;' +
            'font-family:inherit';
        var labelStyle = 'color:var(--text2,#8b949e);margin-right:2px;font-weight:600';

        wrap.innerHTML =
            '<span style="' + labelStyle + '">File:</span>' +
            '<button type="button" data-act="new"  style="' + btnStyle + '" title="Start a new project (clears all calculator inputs)">New</button>' +
            '<button type="button" data-act="open" style="' + btnStyle + '" title="Open a .h2oilproj project file">Open…</button>' +
            '<button type="button" data-act="save" style="' + btnStyle + '" title="Save the project (all inputs on every page)">Save</button>' +
            '<button type="button" data-act="saveas" style="' + btnStyle + '" title="Save the project to a new file">Save As…</button>' +
            '<span data-role="status" style="display:inline-flex;align-items:center;gap:8px;margin-left:4px;' +
                'font-size:11px;white-space:nowrap">' +
              '<span data-role="msg"></span>' +
              '<span data-role="file" style="color:var(--text2,#8b949e);max-width:180px;overflow:hidden;' +
                  'text-overflow:ellipsis;display:none" title="Current project file"></span>' +
              '<span data-role="autosave" style="color:var(--text3,#6e7681)" ' +
                  'title="Every input on every page is saved in this browser automatically">' +
                  '<span style="color:var(--green,#3fb950)">&#9679;</span> Autosave on</span>' +
            '</span>' +
            '<input type="file" data-role="picker" accept=".h2oilproj,.json,application/json" ' +
            'style="display:none">';

        try { container.appendChild(wrap); } catch (e) { return; }

        var msgEl  = wrap.querySelector('[data-role="msg"]');
        var fileEl = wrap.querySelector('[data-role="file"]');
        var autoEl = wrap.querySelector('[data-role="autosave"]');
        var msgTimer = null;

        function _setStatus(msg, kind) {
            if (!msgEl) return;
            var color = (kind === 'err') ? 'var(--red,#f85149)' :
                        (kind === 'ok')  ? 'var(--green,#3fb950)' : 'var(--text2,#8b949e)';
            msgEl.style.color = color;
            msgEl.textContent = String(msg || '');
            clearTimeout(msgTimer);
            if (msg && kind !== 'err') {
                msgTimer = setTimeout(function () {
                    if (msgEl.textContent === msg) msgEl.textContent = '';
                }, 4000);
            }
        }
        function _showFile() {
            if (!fileEl) return;
            var cf = currentFile();
            fileEl.textContent = cf ? cf.name : '';
            fileEl.title = cf ? ('Current project file: ' + cf.name +
                (cf.hasHandle ? ' (Save writes to this file)' : '')) : '';
            fileEl.style.display = cf ? '' : 'none';
        }
        function _showAutosave(at) {
            if (!autoEl || !at) return;
            autoEl.innerHTML = '<span style="color:var(--green,#3fb950)">&#9679;</span> Autosaved ' + _esc(_hhmm(at));
        }
        document.addEventListener('wts:autosaved', function (e) {
            _showAutosave(e && e.detail && e.detail.at);
        });
        document.addEventListener('wts:projectfile', _showFile);
        if (G.WTS_lastAutosave && G.WTS_lastAutosave.at) _showAutosave(G.WTS_lastAutosave.at);
        _showFile();

        function _errMsg(e) { return (e && e.message) ? e.message : String(e); }
        function _loadedMsg(res, name) {
            var ln = res ? (res.loaded || []).length : 0;
            var sk = res ? (res.skipped || []).length : 0;
            return 'Opened ' + (name || 'project') + ' (' + ln + ' modules' + (sk ? ', ' + sk + ' skipped' : '') + ')';
        }

        // Wire buttons.
        var btnNew    = wrap.querySelector('[data-act="new"]');
        var btnOpen   = wrap.querySelector('[data-act="open"]');
        var btnSave   = wrap.querySelector('[data-act="save"]');
        var btnSaveAs = wrap.querySelector('[data-act="saveas"]');
        var picker    = wrap.querySelector('[data-role="picker"]');

        if (btnNew) btnNew.addEventListener('click', function () {
            var ok = true;
            if (typeof G.confirm === 'function') {
                ok = G.confirm('Start a new project?\n\nAll calculator inputs on every page will be cleared ' +
                               '(unit system and "Report prepared by" details are kept). ' +
                               'Save first if you want to keep the current project.');
            }
            if (!ok) return;
            newProject();
            _setStatus('New project started.', 'ok');
        });

        if (btnOpen && picker) {
            btnOpen.addEventListener('click', function () {
                open(picker).then(function (res) {
                    if (!res || res.cancelled || res.deferred) return;
                    if (res.error) _setStatus('Open failed: ' + res.error, 'err');
                    else _setStatus(_loadedMsg(res, res.filename), 'ok');
                }, function (err) {
                    _setStatus('Open failed: ' + _errMsg(err), 'err');
                });
            });
            picker.addEventListener('change', function (ev) {
                var f = ev.target && ev.target.files && ev.target.files[0];
                if (!f) return;
                _setStatus('Opening ' + f.name + '…');
                load(f).then(function (res) {
                    if (res && res.error) {
                        _setStatus('Open failed: ' + res.error, 'err');
                    } else {
                        _setCurrent(null, f.name);
                        _setStatus(_loadedMsg(res, f.name), 'ok');
                    }
                    picker.value = '';
                }, function (err) {
                    _setStatus('Open failed: ' + _errMsg(err), 'err');
                    picker.value = '';
                });
            });
        }

        function _afterSave(r) {
            if (!r || r.cancelled) return;
            _setStatus(r.method === 'download' ? 'Downloaded ' + r.filename :
                       r.method === 'override' ? 'Saved ' + r.filename : 'Saved.', 'ok');
            _showFile();
        }
        function _saveErr(e) { _setStatus('Save failed: ' + _errMsg(e), 'err'); }
        if (btnSave) btnSave.addEventListener('click', function () {
            try { saveCurrent().then(_afterSave, _saveErr); } catch (e) { _saveErr(e); }
        });
        if (btnSaveAs) btnSaveAs.addEventListener('click', function () {
            try { saveAs().then(_afterSave, _saveErr); } catch (e) { _saveErr(e); }
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_project = {
        save:             save,
        saveDownload:     saveDownload,
        saveAs:           saveAs,
        saveCurrent:      saveCurrent,
        open:             open,
        load:             load,
        loadFromObject:   loadFromObject,
        'new':            newProject,   // reserved word — bracket-access from callers
        clearAll:         newProject,   // friendlier alias
        currentFile:      currentFile,
        info:             info,
        registerModule:   registerModule,
        unregisterModule: unregisterModule,
        listModules:      listModules,
        // Synchronous payload builder — primarily for QA / unit tests
        _buildPayload:    _buildPayload
    };
    G.WTS_renderProjectToolbar = renderProjectToolbar;

    // ── Auto-mount into the page-header host (#wts_project_toolbar_host) ──
    (function _autoMountProjectToolbar() {
        if (!_hasDoc) return;
        function mount() {
            try {
                var host = G.document.getElementById('wts_project_toolbar_host');
                if (host && !host.getAttribute('data-mounted')) {
                    renderProjectToolbar(host);
                    host.setAttribute('data-mounted', '1');
                }
            } catch (e) { /* non-fatal */ }
        }
        if (G.document.readyState === 'loading' && G.document.addEventListener) {
            G.document.addEventListener('DOMContentLoaded', mount);
        } else {
            (G.setTimeout || setTimeout)(mount, 0);
        }
    })();

})();

// ─── END 29-project-save ─────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 30-quick-report ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 30 — Cross-Suite Quick Report PDF
//
// PURPOSE
//   Aggregates the most recently calculated outputs from every
//   calculator in the suite into a single, printable HTML report
//   (1-3 pages typical). The user can then "Save as PDF" from the
//   browser print dialog without having to PDF each calculator
//   individually and stitch them together.
//
//   Sections covered (each shown only if the corresponding module
//   has state under window.WTS_state.*):
//     • Header  — client / well / field, date, suite version
//     • WTS Flow Profile Summary
//     • ESD Hi-Pilot Analysis        (PASS / FAIL)
//     • ESD Lo-Pilot Analysis        (REACHABLE / UNREACHABLE)
//     • Hydrate Management Summary   (per-node risk + MeOH duty)
//     • Liquid Line / RO Sizing      (PROTECTED / UNDERSIZED)
//     • Pipe Service Life            (limiting segment, remaining days)
//     • PRiSM Well Test Analysis     (model, R², RMSE, AIC, k, kh, S, C,
//                                     ΔpS, FE, parameters, interpretation)
//
// PUBLIC API
//   window.WTS_quickReport = {
//       generate(opts?) → triggers window.print() with the report,
//       preview(opts?)  → returns the report HTML for inline preview,
//       setModules(keys) → which sections to include (default: all),
//       getModules()    → array of currently-selected module keys,
//       availableModules() → array of module keys that have state
//   };
//   window.WTS_renderQuickReportButton(container)
//       → mounts a "Quick Report" button into a host container
//
// CONVENTIONS
//   • Single outer IIFE, 'use strict'
//   • Vanilla JS only (Math.* + window.print)
//   • Print-friendly: @media print rules size at A4 portrait,
//     12px serif/sans body, hides on-screen controls
//   • Defensive: missing modules show a "Not run yet" placeholder
//     rather than throwing
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    function _log()  { if (typeof console !== 'undefined' && console.log)  try { console.log.apply(console, arguments); }  catch (e) {} }
    function _warn() { if (typeof console !== 'undefined' && console.warn) try { console.warn.apply(console, arguments); } catch (e) {} }
    function _err()  { if (typeof console !== 'undefined' && console.error) try { console.error.apply(console, arguments); } catch (e) {} }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function _isNum(v) { return (typeof v === 'number') && isFinite(v); }
    function _fmt(v, dp) {
        if (!_isNum(v)) return '—';
        var d = (dp == null) ? 2 : dp;
        if (Math.abs(v) >= 1e6) return v.toExponential(3);
        if (Math.abs(v) >= 1000) return v.toFixed(Math.min(d, 0));
        if (Math.abs(v) >= 1)    return v.toFixed(d);
        return v.toFixed(Math.max(d, 3));
    }
    function _fmtInt(v) {
        if (!_isNum(v)) return '—';
        return Math.round(v).toLocaleString('en-US');
    }
    function _statusBadge(text, color) {
        return '<span style="display:inline-block;padding:2px 8px;border-radius:3px;' +
               'background:' + color + ';color:#fff;font-weight:600;font-size:11px;' +
               'letter-spacing:.04em;text-transform:uppercase">' + _esc(text) + '</span>';
    }
    function _greenBadge(text)  { return _statusBadge(text || 'PASS', '#2e8540'); }
    function _redBadge(text)    { return _statusBadge(text || 'FAIL', '#b22222'); }
    function _yellowBadge(text) { return _statusBadge(text || 'WARN', '#b59000'); }

    // ───────────────────────────────────────────────────────────────
    // Module catalogue — which keys to render, in what order, with
    // what label and what state-reader. Forward-compatible: adding a
    // new module is one line here.
    // ───────────────────────────────────────────────────────────────
    var MODULE_CATALOG = [
        { key: 'header',     label: 'Header' },
        { key: 'wts',        label: 'WTS Flow Profile Summary' },
        { key: 'esdhi',      label: 'ESD Hi-Pilot Analysis' },
        { key: 'esdlo',      label: 'ESD Lo-Pilot Analysis' },
        { key: 'hydrate',    label: 'Hydrate Management' },
        { key: 'liquidline', label: 'Liquid Line / RO Sizing' },
        { key: 'pipelife',   label: 'Pipe Service Life' },
        { key: 'prism',      label: 'PRiSM Well Test Analysis' }
    ];

    var SELECTED = null;   // null = all; otherwise array of keys

    function setModules(keys) {
        if (!keys) { SELECTED = null; return getModules(); }
        if (!Array.isArray(keys)) { SELECTED = null; return getModules(); }
        SELECTED = keys.slice();
        return SELECTED.slice();
    }
    function getModules() {
        if (SELECTED) return SELECTED.slice();
        var out = [];
        for (var i = 0; i < MODULE_CATALOG.length; i++) out.push(MODULE_CATALOG[i].key);
        return out;
    }
    function availableModules() {
        var out = [];
        for (var i = 0; i < MODULE_CATALOG.length; i++) {
            var k = MODULE_CATALOG[i].key;
            if (k === 'header') continue;
            if (_hasState(k)) out.push(k);
        }
        return out;
    }

    function _hasState(key) {
        switch (key) {
            case 'wts':        return !!(G.WTS_state && (G.WTS_state.nodes || G.WTS_state.flow));
            case 'esdhi':      return !!(G.WTS_state && G.WTS_state.esdHiPilot);
            case 'esdlo':      return !!(G.WTS_state && G.WTS_state.esdLoPilot);
            case 'hydrate':    return !!(G.WTS_state && G.WTS_state.hydrate);
            case 'liquidline': return !!(G.WTS_state && G.WTS_state.liquidline);
            case 'pipelife':   return !!(G.WTS_state && G.WTS_state.pipelife);
            case 'prism': {
                // A fit exists, or a model is chosen and data is loaded.
                if (_prismFit()) return true;
                var st = G.PRiSM_state, ds = G.PRiSM_dataset;
                return !!(st && st.model && ds && ds.t && ds.t.length);
            }
            default:           return false;
        }
    }

    // ─── PRiSM helpers ────────────────────────────────────────────
    // Last fit through the C4 getter (normalised keys), else the raw state
    // with both key spellings accepted (R2/r2, RMSE/rmse, AIC/aic, model/modelKey).
    function _num() {
        for (var i = 0; i < arguments.length; i++) if (_isNum(arguments[i])) return arguments[i];
        return NaN;
    }
    function _prismFit() {
        var f = null;
        if (typeof G.PRiSM_getLastFit === 'function') {
            try { f = G.PRiSM_getLastFit(); } catch (e) { f = null; }
        }
        if (!f && G.PRiSM_state && G.PRiSM_state.lastFit && typeof G.PRiSM_state.lastFit === 'object') f = G.PRiSM_state.lastFit;
        if (!f) return null;
        return {
            modelKey: f.modelKey || f.model || (G.PRiSM_state && G.PRiSM_state.model) || null,
            source: f.source || '', kind: f.kind || 'pressure',
            r2: _num(f.r2, f.R2), rmse: _num(f.rmse, f.RMSE), aic: _num(f.aic, f.AIC),
            ci95: f.ci95 || f.CI95 || {}, params: f.params || {}, phys: f.phys || {},
            converged: f.converged, iterations: f.iterations, stale: !!f.stale
        };
    }
    function _prismModelLabel(key) {
        var e = key && G.PRiSM_MODELS ? G.PRiSM_MODELS[key] : null;
        var lbl = (e && (e.label || e.name)) || '';
        if (!lbl && key) lbl = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); });
        return lbl;
    }
    // Key results: the report layer's summary when present, else computed
    // here from lastFit.phys and the well inputs (field units).
    function _prismResults(fit) {
        if (typeof G.PRiSM_reportResults === 'function') {
            try { var r = G.PRiSM_reportResults(); if (r) return r; } catch (e) { _warn('reportResults failed', e); }
        }
        var ph = (fit && fit.phys) || {};
        var w = null;
        if (typeof G.PRiSM_getWell === 'function') { try { w = G.PRiSM_getWell(); } catch (e) { w = null; } }
        if (!w) {
            var s = G.PRiSM_pvt || {}, c = s._computed || {};
            w = { q: s.q, B: _num(s.Bo, c.B), mu: _num(s.mu_o, c.mu), h: s.h, rw: s.rw,
                  pi: (s.provenance && s.provenance.p_res && s.provenance.p_res !== 'default') ? s.p_res : null, fluid: s.fluidType };
        }
        var k = _num(ph.k), kh = _num(ph.kh, k * w.h), S = _num(ph.S, fit && fit.params ? fit.params.S : NaN);
        var out = { k: k, kh: kh, S: S, C: _num(ph.C), Cd: _num(ph.Cd, fit && fit.params ? fit.params.Cd : NaN), dpS: NaN, FE: NaN };
        if (w.fluid !== 'gas') out.dpS = 141.2 * w.q * w.B * w.mu * S / kh;
        var ds = G.PRiSM_dataset, pi = _num(ph.pi, w.pi);
        if (_isNum(out.dpS) && _isNum(pi) && ds && ds.p && ds.p.length) {
            var pwf = ds.p[ds.p.length - 1], dd = pi - pwf;
            if (_isNum(pwf) && dd > 0) out.FE = (dd - out.dpS) / dd;
        }
        return out;
    }

    // ───────────────────────────────────────────────────────────────
    // Section renderers — each returns a full HTML fragment for the
    // report (or a "Not run yet" placeholder).
    // ───────────────────────────────────────────────────────────────
    function _placeholder(label) {
        return '<div class="qr-placeholder">' + _esc(label) + ' — not run yet.</div>';
    }

    function _row(label, value, units) {
        var v = (value === undefined || value === null || value === '') ? '—' : _esc(value);
        if (units) v += ' <span class="qr-units">' + _esc(units) + '</span>';
        return '<tr><th>' + _esc(label) + '</th><td>' + v + '</td></tr>';
    }

    function _section(title, bodyHTML, extra) {
        var ex = extra ? (' ' + extra) : '';
        return '<section class="qr-section"' + ex + '>' +
               '<h2 class="qr-section-title">' + _esc(title) + '</h2>' +
               bodyHTML + '</section>';
    }

    // ─── Header ───────────────────────────────────────────────────
    function _renderHeader() {
        // Client & Well Info page persists to localStorage 'h2oil_client_info'
        // ({client, well, field, ref, engineer, …}); WTS_state.clientInfo is
        // only populated by project files.
        var ci = {};
        try { ci = JSON.parse(G.localStorage.getItem('h2oil_client_info') || '{}') || {}; } catch (e) { ci = {}; }
        if (G.WTS_state && G.WTS_state.clientInfo) {
            var pci = G.WTS_state.clientInfo;
            for (var pk in pci) if (Object.prototype.hasOwnProperty.call(pci, pk) && ci[pk] == null) ci[pk] = pci[pk];
        }
        ci.clientName = ci.clientName || ci.client;
        ci.wellName   = ci.wellName   || ci.well;
        ci.jobId      = ci.jobId      || ci.ref;
        var now = new Date();
        var dateStr = now.toISOString().substring(0, 10) + ' ' +
                      now.toTimeString().substring(0, 5);
        var version = (G.WTS_VERSION || G.PRiSM_VERSION || '1.0');
        var meta =
            '<table class="qr-meta">' +
            '<tr><th>Client</th><td>' + _esc(ci.clientName || ci.operator || '—') + '</td>' +
            '<th>Well</th><td>' + _esc(ci.wellName || '—') + '</td></tr>' +
            '<tr><th>Field</th><td>' + _esc(ci.fieldName || ci.field || '—') + '</td>' +
            '<th>Date</th><td>' + _esc(dateStr) + '</td></tr>' +
            '<tr><th>Job ID</th><td>' + _esc(ci.jobId || ci.afe || '—') + '</td>' +
            '<th>Engineer</th><td>' + _esc(ci.engineer || ci.user || '—') + '</td></tr>' +
            '</table>';
        return '<header class="qr-header">' +
               '<div class="qr-logo">H2Oil</div>' +
               '<div class="qr-titleblock">' +
               '<h1>Well Testing Suite — Quick Report</h1>' +
               '<div class="qr-subtitle">Aggregated calculator outputs · suite v' +
               _esc(version) + '</div>' +
               '</div>' +
               '</header>' + meta;
    }

    // ─── WTS Flow Profile ─────────────────────────────────────────
    function _renderWTSSummary() {
        if (!_hasState('wts')) return _placeholder('WTS Flow Profile');
        var s = G.WTS_state;
        var rows = '';
        var fp = s.flow || {};
        rows += _row('Wellhead Pressure', _fmt(fp.wellheadPressure, 0), 'psig');
        rows += _row('Wellhead Temperature', _fmt(fp.wellheadTemp, 1), '°F');
        rows += _row('Gas Rate',  _fmt(fp.gasRate, 2),  'MMscf/d');
        rows += _row('Oil Rate',  _fmtInt(fp.oilRate),  'STB/d');
        rows += _row('Water Rate', _fmtInt(fp.waterRate), 'bbl/d');
        rows += _row('Choke Bean', _fmt(fp.chokeBean, 0), '/64"');
        rows += _row('Separator Pressure', _fmt(fp.separatorPressure, 0), 'psig');

        var nodeRows = '';
        if (Array.isArray(s.nodes) && s.nodes.length) {
            nodeRows =
                '<h3 class="qr-h3">Node-by-Node Profile</h3>' +
                '<table class="qr-table">' +
                '<thead><tr><th>Node</th><th>P (psig)</th><th>T (°F)</th><th>v (ft/s)</th></tr></thead><tbody>';
            for (var i = 0; i < s.nodes.length; i++) {
                var n = s.nodes[i] || {};
                nodeRows += '<tr><td>' + _esc(n.label || n.name || ('#' + (i + 1))) + '</td>' +
                            '<td>' + _fmt(n.pressure, 0) + '</td>' +
                            '<td>' + _fmt(n.temperature, 1) + '</td>' +
                            '<td>' + _fmt(n.velocity, 1) + '</td></tr>';
            }
            nodeRows += '</tbody></table>';
        }
        return _section('WTS Flow Profile Summary',
            '<table class="qr-kv">' + rows + '</table>' + nodeRows);
    }

    // ─── ESD Hi-Pilot ─────────────────────────────────────────────
    function _renderESDHi() {
        if (!_hasState('esdhi')) return _placeholder('ESD Hi-Pilot');
        var e = G.WTS_state.esdHiPilot;
        var badge = (e.pass === true)  ? _greenBadge('PASS') :
                    (e.pass === false) ? _redBadge('FAIL') :
                                         _yellowBadge('INDETERMINATE');
        var rows = '';
        rows += _row('Hi-Pilot Setting',     _fmt(e.hiPilotSetting_psig, 0), 'psig');
        rows += _row('Rupture Disc Setting', _fmt(e.rdSetting_psig, 0),       'psig');
        rows += _row('Section MAWP',         _fmt(e.mawp_psig, 0),            'psig');
        rows += _row('Time to Reach RV',     _fmt(e.timeToReachRV_s, 2),      's');
        rows += _row('ESD Response Window',  _fmt(e.esdResponseTime_s, 2),    's');
        rows += _row('Margin',                _fmt(e.marginSeconds, 2),        's');
        rows += _row('Gas Released to Atm.', _fmtInt(e.gasReleasedToAtmosphere_scf), 'scf');
        var rationale = e.rationale ? ('<p class="qr-rationale">' + _esc(e.rationale) + '</p>') : '';
        return _section('ESD Hi-Pilot Analysis',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + rationale);
    }

    // ─── ESD Lo-Pilot ─────────────────────────────────────────────
    function _renderESDLo() {
        if (!_hasState('esdlo')) return _placeholder('ESD Lo-Pilot');
        var e = G.WTS_state.esdLoPilot;
        var reachable = (e.reachable === true);
        var badge = reachable ? _greenBadge('REACHABLE') : _redBadge('UNREACHABLE');
        var rows = '';
        rows += _row('Lo-Pilot (PSL) Target', _fmt(e.psl_target_psig, 0), 'psig');
        rows += _row('Operating Pressure',    _fmt(e.operating_psig, 0),  'psig');
        rows += _row('Drawdown Required',     _fmt(e.drawdown_psi, 0),    'psi');
        rows += _row('Detection Time',        _fmt(e.detectionTime_s, 1), 's');
        var note = e.recommendation ? ('<p class="qr-rationale">' + _esc(e.recommendation) + '</p>') : '';
        return _section('ESD Lo-Pilot Analysis',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + note);
    }

    // ─── Hydrate Management ───────────────────────────────────────
    function _renderHydrate() {
        if (!_hasState('hydrate')) return _placeholder('Hydrate Management');
        var h = G.WTS_state.hydrate;
        var nodes = Array.isArray(h.nodes) ? h.nodes : [];
        var red = 0, yellow = 0, green = 0;
        var totalMeOH = 0;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var r = String(n.risk || '').toLowerCase();
            if (r === 'red')    red++;
            else if (r === 'yellow') yellow++;
            else green++;
            if (_isNum(n.meoh_ccmin)) totalMeOH += n.meoh_ccmin;
        }
        var summary =
            '<p class="qr-status">Risk: ' +
            _redBadge(red + ' RED') + ' &nbsp; ' +
            _yellowBadge(yellow + ' YELLOW') + ' &nbsp; ' +
            _greenBadge(green + ' GREEN') + '</p>';
        var rows = '';
        rows += _row('Inhibitor', h.inhibitor || 'MeOH');
        rows += _row('Total Inhibitor Required', _fmt(totalMeOH || h.total_inhibitor_ccmin, 1), 'cc/min');
        rows += _row('Subcooling Margin', _fmt(h.subcooling_F, 1), '°F');
        var nodeTbl = '';
        if (nodes.length) {
            nodeTbl =
                '<h3 class="qr-h3">Per-Node Risk</h3>' +
                '<table class="qr-table"><thead>' +
                '<tr><th>Node</th><th>T (°F)</th><th>P (psig)</th><th>Hydrate T (°F)</th>' +
                '<th>Δsub (°F)</th><th>Risk</th></tr></thead><tbody>';
            for (var j = 0; j < nodes.length; j++) {
                var nn = nodes[j];
                var rk = String(nn.risk || '').toLowerCase();
                var rkBadge = (rk === 'red')    ? _redBadge('RED') :
                              (rk === 'yellow') ? _yellowBadge('YELLOW') :
                                                  _greenBadge('GREEN');
                nodeTbl += '<tr><td>' + _esc(nn.label || nn.name || ('Node ' + (j + 1))) + '</td>' +
                           '<td>' + _fmt(nn.temp_F, 1) + '</td>' +
                           '<td>' + _fmt(nn.p_psig, 0) + '</td>' +
                           '<td>' + _fmt(nn.thyd_F, 1) + '</td>' +
                           '<td>' + _fmt(nn.subcool_F, 1) + '</td>' +
                           '<td>' + rkBadge + '</td></tr>';
            }
            nodeTbl += '</tbody></table>';
        }
        return _section('Hydrate Management', summary + '<table class="qr-kv">' + rows + '</table>' + nodeTbl);
    }

    // ─── Liquid Line / RO ──────────────────────────────────────────
    function _renderLiquidLine() {
        if (!_hasState('liquidline')) return _placeholder('Liquid Line / RO Sizing');
        var l = G.WTS_state.liquidline;
        var protected_ = (l.protected === true || l.status === 'PROTECTED');
        var badge = protected_ ? _greenBadge('PROTECTED') : _redBadge('UNDERSIZED');
        var rows = '';
        rows += _row('Recommended RO',  _fmt(l.ro_recommended_64ths, 0), '/64"');
        rows += _row('Selected RO',     _fmt(l.ro_selected_64ths, 0),    '/64"');
        rows += _row('Velocity at RO',  _fmt(l.velocity_ftps, 1),        'ft/s');
        rows += _row('LCV Size',        _fmt(l.lcv_in, 2),               'in');
        rows += _row('Gas Blowby Margin', _fmt(l.blowby_margin, 2), '');
        var note = l.note ? ('<p class="qr-rationale">' + _esc(l.note) + '</p>') : '';
        return _section('Liquid Line / RO Sizing',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + note);
    }

    // ─── Pipe Service Life ────────────────────────────────────────
    function _renderPipeLife() {
        if (!_hasState('pipelife')) return _placeholder('Pipe Service Life');
        var p = G.WTS_state.pipelife;
        var lim = p.limiting_segment || {};
        var days = _isNum(p.overall_min_life_days) ? p.overall_min_life_days : null;
        var badge;
        if (days == null)        badge = _yellowBadge('N/A');
        else if (days < 30)      badge = _redBadge('CRITICAL');
        else if (days < 180)     badge = _yellowBadge('MONITOR');
        else                     badge = _greenBadge('OK');
        var rows = '';
        rows += _row('Limiting Segment', lim.label || lim.name || '—');
        rows += _row('Remaining Service Life', _fmt(days, 1), 'days');
        rows += _row('Time-to-Failure (current WT)', _fmt(lim.time_to_failure_at_current_days, 1), 'days');
        rows += _row('Erosion Rate', _fmt(lim.erosion_rate_mils_yr, 1), 'mils/year');
        rows += _row('Sand Rate', _fmt(p.sand_rate_lbMMscf, 1), 'lb/MMscf');
        rows += _row('Salama c-factor', _fmt(p.c_constant, 0), '');

        var segs = Array.isArray(p.segments) ? p.segments : [];
        var segTbl = '';
        if (segs.length) {
            segTbl =
                '<h3 class="qr-h3">All Segments</h3>' +
                '<table class="qr-table"><thead>' +
                '<tr><th>Segment</th><th>Erosion (mpy)</th><th>RSL (days)</th><th>TTF (days)</th><th>MAWP (psig)</th></tr></thead><tbody>';
            for (var i = 0; i < segs.length; i++) {
                var sg = segs[i] || {};
                segTbl += '<tr><td>' + _esc(sg.label || sg.name || ('#' + (i + 1))) + '</td>' +
                          '<td>' + _fmt(sg.erosion_rate_mils_yr, 1) + '</td>' +
                          '<td>' + _fmt(sg.remaining_service_life_days, 1) + '</td>' +
                          '<td>' + _fmt(sg.time_to_failure_at_current_days, 1) + '</td>' +
                          '<td>' + _fmt(sg.max_allowable_pressure_psig, 0) + '</td></tr>';
            }
            segTbl += '</tbody></table>';
        }
        return _section('Pipe Service Life',
            '<p class="qr-status">Status: ' + badge + '</p>' +
            '<table class="qr-kv">' + rows + '</table>' + segTbl);
    }

    // ─── PRiSM Well Test Analysis ──────────────────────────────────
    var PRISM_SOURCES = { regression: 'Regression', automatch: 'Auto-match', match: 'Type-curve match', semilog: 'Straight line' };
    function _sig(v, n) {
        if (!_isNum(v)) return '—';
        var a = Math.abs(v);
        if (a === 0) return '0';
        if (a >= 1e5 || a < 1e-3) return v.toExponential(n - 1).replace('e+', 'e');
        return v.toFixed(Math.max(0, n - 1 - Math.floor(Math.log(a) / Math.LN10 + 1e-12)));
    }
    function _pm(ci, key, dp) {
        var c = ci && ci[key];
        if (!c || c.length !== 2 || !_isNum(c[0]) || !_isNum(c[1])) return '';
        return ' ± ' + (Math.abs(c[1] - c[0]) / 2).toFixed(dp);
    }
    function _renderPRiSM() {
        if (!_hasState('prism')) return _placeholder('PRiSM Well Test Analysis');
        var ps = G.PRiSM_state || {};
        var fit = _prismFit();
        var key = (fit && fit.modelKey) || ps.model || '';
        var res = fit ? (_prismResults(fit) || {}) : {};
        var rows = '';
        rows += _row('Model', key ? (res.modelLabel || _prismModelLabel(key)) + ' (' + key + ')' : '—');
        if (!fit) {
            rows += _row('Result', 'No fit yet — model chosen and data loaded');
            return _section('PRiSM Well Test Analysis', '<table class="qr-kv">' + rows + '</table>');
        }
        var ci = res.ci || fit.ci95 || {};
        rows += _row('Result from', PRISM_SOURCES[fit.source] || fit.source || '—');
        rows += _row('R²', _isNum(fit.r2) ? fit.r2.toFixed(5) : '—');
        rows += _row('RMSE', _sig(fit.rmse, 3), fit.kind === 'rate' ? 'rate units' : 'psi');
        rows += _row('AIC', _isNum(fit.aic) ? fit.aic.toFixed(1) : '—');
        if (fit.kind !== 'rate') {
            rows += _row('Permeability k', _isNum(res.k) ? _sig(res.k, 3) + _pm(ci, 'k', res.k >= 10 ? 1 : 2) : '—', 'md');
            rows += _row('Permeability-thickness kh', _sig(res.kh, 4), 'md·ft');
            rows += _row('Skin S', _isNum(res.S) ? res.S.toFixed(2) + _pm(ci, 'S', 2) : '—');
            rows += _row('Wellbore storage C', _sig(res.C, 3), 'bbl/psi');
            rows += _row('Pressure drop due to skin ΔpS', _sig(res.dpS, 3), 'psi');
            rows += _row('Flow efficiency FE', _sig(res.FE, 3));
        }
        if (fit.stale) rows += _row('Note', 'The fit was made on different data or a different model — re-run it.');
        var params = fit.params || {};
        var paramRows = '';
        var paramKeys = [];
        for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k) && k.indexOf('__') !== 0) paramKeys.push(k);
        if (paramKeys.length) {
            paramRows = '<h3 class="qr-h3">Model Parameters</h3>' +
                '<table class="qr-table"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>';
            for (var pi = 0; pi < paramKeys.length; pi++) {
                var pk = paramKeys[pi];
                var pv = params[pk];
                paramRows += '<tr><td>' + _esc(pk) + '</td><td>' +
                             (_isNum(pv) ? _fmt(pv, 4) : _esc(Array.isArray(pv) ? '(' + pv.length + ' items)' : pv)) + '</td></tr>';
            }
            paramRows += '</tbody></table>';
        }
        var narrative = (ps.interp && ps.interp.narrative) || '';
        var interp = narrative ? ('<p class="qr-rationale">' + _esc(narrative) + '</p>') : '';
        return _section('PRiSM Well Test Analysis',
            '<table class="qr-kv">' + rows + '</table>' + paramRows + interp);
    }

    // ───────────────────────────────────────────────────────────────
    // CSS (print-friendly)
    // ───────────────────────────────────────────────────────────────
    function _styles() {
        return [
            '@page { size: A4 portrait; margin: 14mm 12mm; }',
            'body.qr-print { background:#fff;color:#000;font-family:Segoe UI,Calibri,Arial,sans-serif;' +
                'font-size:11pt;line-height:1.4;margin:0;padding:0; }',
            '.qr-page { max-width:190mm;margin:0 auto;padding:8mm 6mm; }',
            '.qr-controls { display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;' +
                'background:#f3f4f6;border-bottom:1px solid #d0d7de; }',
            '.qr-controls button { padding:6px 14px;background:#1f6feb;color:#fff;border:0;' +
                'border-radius:4px;cursor:pointer;font-size:12px;font-weight:600 }',
            '.qr-controls button.secondary { background:#fff;color:#1f6feb;border:1px solid #1f6feb }',
            '@media print { .qr-controls { display:none !important } }',
            'header.qr-header { display:flex;align-items:center;gap:16px;padding-bottom:10px;' +
                'border-bottom:3px solid #1f6feb;margin-bottom:10px }',
            '.qr-logo { font-size:28pt;font-weight:800;letter-spacing:-1px;color:#1f6feb }',
            '.qr-titleblock h1 { font-size:18pt;margin:0;color:#1f3a5f;font-weight:700 }',
            '.qr-subtitle { font-size:10pt;color:#6e7681;margin-top:2px }',
            '.qr-meta { width:100%;border-collapse:collapse;margin-bottom:12px;font-size:10pt }',
            '.qr-meta th { background:#f3f4f6;color:#1f3a5f;font-weight:600;text-align:left;' +
                'padding:4px 8px;border:1px solid #d0d7de;width:15% }',
            '.qr-meta td { padding:4px 8px;border:1px solid #d0d7de;width:35% }',
            '.qr-section { page-break-inside:avoid;margin-bottom:14px;padding-bottom:6px;' +
                'border-bottom:1px dotted #d0d7de }',
            '.qr-section:last-child { border-bottom:0 }',
            '.qr-section-title { font-size:13pt;color:#1f3a5f;margin:0 0 6px 0;font-weight:700;' +
                'border-bottom:1px solid #1f6feb;padding-bottom:2px }',
            '.qr-h3 { font-size:11pt;margin:8px 0 4px;color:#1f3a5f;font-weight:600 }',
            '.qr-status { margin:4px 0 8px 0;font-size:11pt;font-weight:600 }',
            '.qr-rationale { margin:6px 0 0;font-size:10pt;color:#444;font-style:italic;' +
                'background:#f9fafb;padding:6px 10px;border-left:3px solid #1f6feb }',
            '.qr-kv { width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:6px }',
            '.qr-kv th { background:#f8f9fb;color:#222;font-weight:600;text-align:left;' +
                'padding:3px 8px;width:38%;border:1px solid #e5e7eb }',
            '.qr-kv td { padding:3px 8px;border:1px solid #e5e7eb }',
            '.qr-units { color:#6e7681;font-size:9pt }',
            '.qr-table { width:100%;border-collapse:collapse;font-size:9pt;margin:4px 0 8px }',
            '.qr-table th { background:#1f3a5f;color:#fff;font-weight:600;text-align:left;' +
                'padding:4px 8px;border:1px solid #1f3a5f }',
            '.qr-table td { padding:3px 8px;border:1px solid #e5e7eb }',
            '.qr-table tr:nth-child(even) td { background:#fafbfc }',
            '.qr-placeholder { padding:8px 12px;background:#f9fafb;color:#6e7681;border:1px dashed #d0d7de;' +
                'border-radius:4px;font-style:italic;font-size:10pt;margin-bottom:10px }',
            '.qr-footer { font-size:8pt;color:#6e7681;text-align:center;margin-top:14px;' +
                'border-top:1px solid #e5e7eb;padding-top:6px }'
        ].join('\n');
    }

    // ───────────────────────────────────────────────────────────────
    // Assemble the full HTML doc
    // ───────────────────────────────────────────────────────────────
    function _renderSection(key) {
        switch (key) {
            case 'header':     return _renderHeader();
            case 'wts':        return _renderWTSSummary();
            case 'esdhi':      return _renderESDHi();
            case 'esdlo':      return _renderESDLo();
            case 'hydrate':    return _renderHydrate();
            case 'liquidline': return _renderLiquidLine();
            case 'pipelife':   return _renderPipeLife();
            case 'prism':      return _renderPRiSM();
            default:           return '';
        }
    }

    function _buildHTML(opts) {
        opts = opts || {};
        var keys = opts.modules ? opts.modules.slice() : getModules();
        var sections = [];
        // Always emit header first if it's in the catalog (even if not selected)
        var hasHeader = false;
        for (var i = 0; i < keys.length; i++) if (keys[i] === 'header') hasHeader = true;
        if (!hasHeader) sections.push(_renderSection('header'));
        for (var j = 0; j < keys.length; j++) sections.push(_renderSection(keys[j]));
        var generated = new Date().toISOString();
        var version = (G.WTS_VERSION || G.PRiSM_VERSION || '1.0');
        var footer = '<div class="qr-footer">Generated by H2Oil Well Testing Suite v' +
                     _esc(version) + ' · ' + _esc(generated) + '</div>';
        return '<!DOCTYPE html>' +
               '<html lang="en"><head><meta charset="utf-8">' +
               '<title>H2Oil Well Testing — Quick Report</title>' +
               '<style>' + _styles() + '</style>' +
               '</head><body class="qr-print">' +
               '<div class="qr-controls">' +
               '<button class="secondary" onclick="window.close()">Close</button>' +
               '<button onclick="window.print()">Print / Save PDF</button>' +
               '</div>' +
               '<div class="qr-page">' + sections.join('') + footer + '</div>' +
               '</body></html>';
    }

    // ───────────────────────────────────────────────────────────────
    // preview(opts) → returns HTML string (without auto-print)
    // ───────────────────────────────────────────────────────────────
    function preview(opts) {
        try { return _buildHTML(opts); }
        catch (e) { _err('preview failed', e); return '<!-- preview error: ' + _esc(e.message) + ' -->'; }
    }

    // ───────────────────────────────────────────────────────────────
    // generate(opts) → opens a new window with the report and triggers print
    // ───────────────────────────────────────────────────────────────
    function generate(opts) {
        // The host's job report covers every calculator the user has run
        // (captured automatically), with the shared report styling, the
        // Client & Well Info cover and the iOS PDF path. The legacy
        // per-module summary below remains as a fallback.
        if (typeof G.WTS_exportJobReport === 'function') {
            try { G.WTS_exportJobReport(opts); return { opened: true, delegated: true }; }
            catch (e) { _warn('job report failed — falling back to legacy quick report', e); }
        }
        var html = _buildHTML(opts);
        if (!_hasWin || typeof G.open !== 'function') {
            return { html: html, opened: false };
        }
        var w = null;
        try { w = G.open('', 'WTS_quickReport', 'width=820,height=1080'); }
        catch (e) { w = null; }
        if (!w) {
            _warn('Quick Report popup blocked — returning HTML for caller');
            return { html: html, opened: false };
        }
        try {
            w.document.open();
            w.document.write(html);
            w.document.close();
            // Trigger print after a tick so the document is parsed
            try {
                w.setTimeout(function () {
                    try { w.focus(); w.print(); } catch (e) {}
                }, 250);
            } catch (e) {}
        } catch (e) {
            _err('Quick Report write failed', e);
        }
        return { html: html, opened: true, win: w };
    }

    // ───────────────────────────────────────────────────────────────
    // Mount the "Quick Report" button
    // ───────────────────────────────────────────────────────────────
    function renderQuickReportButton(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;
        var existing = (container.querySelector)
            ? container.querySelector('[data-wts-qr-btn="1"]') : null;
        if (existing) return;
        var btn = document.createElement('button');
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-wts-qr-btn', '1');
        btn.className = 'btn btn-primary';
        btn.style.cssText =
            'padding:6px 14px;background:#1f6feb;border:1px solid #1f6feb;border-radius:4px;' +
            'color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:Segoe UI,sans-serif';
        btn.innerHTML = 'Quick Report';
        btn.title = 'Generate a single-PDF aggregated summary of every calculator that has been run.';
        btn.addEventListener('click', function () {
            try { generate(); }
            catch (e) { _err('Quick Report button click failed', e); }
        });
        try { container.appendChild(btn); } catch (e) {}
        // Template picker (host WTS_reportTemplates: daily / final / user templates).
        var tpl = document.createElement('button');
        tpl.setAttribute('type', 'button');
        tpl.setAttribute('data-wts-qr-tpl', '1');
        tpl.setAttribute('aria-label', 'Report templates');
        tpl.setAttribute('aria-haspopup', 'dialog');
        tpl.className = 'btn btn-primary';
        tpl.style.cssText =
            'padding:6px 9px;margin-left:2px;background:#1f6feb;border:1px solid #1f6feb;border-radius:4px;' +
            'color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:Segoe UI,sans-serif';
        tpl.innerHTML = '&#9662;';
        tpl.title = 'Report templates — daily or final well-test report, or your own template.';
        tpl.addEventListener('click', function () {
            try {
                if (G.WTS_reportTemplates && typeof G.WTS_reportTemplates.openPicker === 'function') G.WTS_reportTemplates.openPicker();
                else generate();
            } catch (e) { _err('Report templates button click failed', e); }
        });
        try { container.appendChild(tpl); } catch (e) {}
    }

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_quickReport = {
        generate:           generate,
        preview:            preview,
        setModules:         setModules,
        getModules:         getModules,
        availableModules:   availableModules
    };
    G.WTS_renderQuickReportButton = renderQuickReportButton;

    // ── Auto-mount into the page-header host (#wts_quick_report_host) ──
    (function _autoMountQuickReport() {
        if (!_hasDoc) return;
        function mount() {
            try {
                var host = G.document.getElementById('wts_quick_report_host');
                if (host && !host.getAttribute('data-mounted')) {
                    renderQuickReportButton(host);
                    host.setAttribute('data-mounted', '1');
                }
            } catch (e) { /* non-fatal */ }
        }
        if (G.document.readyState === 'loading' && G.document.addEventListener) {
            G.document.addEventListener('DOMContentLoaded', mount);
        } else {
            (G.setTimeout || setTimeout)(mount, 0);
        }
    })();

})();

// ─── END 30-quick-report ─────────────────────────────────────────────

