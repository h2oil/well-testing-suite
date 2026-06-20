
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
            description:  String(meta.description || ''),
            typicalRange: String(meta.typicalRange || ''),
            units:        String(meta.units || ''),
            references:   Array.isArray(meta.references) ? meta.references.slice() : []
        };
        return true;
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
            description: 'Wellbore storage coefficient (PRiSM uses dimensionless Cd). Surface ' +
                         'shut-ins typically 1,000-10,000; downhole shut-ins 1-100.',
            typicalRange: '1 – 100,000 (dimensionless)',
            units: 'dimensionless',
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
            description: 'Bo (oil) or Bg (gas). Bo: 1.05-2.5 rb/STB; Bg: 0.003-0.02 rb/scf. ' +
                         'Use Standing or DAK correlations at reservoir P,T.',
            typicalRange: 'See description',
            units: 'rb/STB or rb/scf',
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

        // ─── PRiSM-specific ────────────────────────────────────────
        'PRiSM_kh': {
            description: 'Permeability-thickness product (kh) from semi-log slope. ' +
                         'kh = 162.6·q·B·μ / m  (oil); kh = 1637·qg·μ·Z·T / m  (gas).',
            typicalRange: '1 – 100,000 mD-ft',
            units: 'mD-ft'
        },
        'PRiSM_pInitial': {
            description: 'Initial reservoir pressure used as the upper-bound of buildup ' +
                         'extrapolation (Horner / MDH p*).',
            typicalRange: '500 – 15,000 psia',
            units: 'psia'
        },
        'PRiSM_skin': {
            description: 'Apparent skin S from Δp at 1 hr. Negative indicates stimulation; ' +
                         'positive indicates damage or partial penetration.',
            typicalRange: '-5 to +30',
            units: 'dimensionless'
        },
        'PRiSM_xf': {
            description: 'Hydraulic-fracture half-length. Driven by Bourdet derivative ' +
                         'half-slope onset time during linear-flow regime.',
            typicalRange: '20 – 800 ft',
            units: 'ft'
        },
        'PRiSM_FcD': {
            description: 'Dimensionless fracture conductivity FcD = kf·w / (k·xf). ' +
                         'FcD < 10 = finite conductivity; FcD > 30 = infinite.',
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
            '#' + TOOLTIP_ID + '{position:fixed;z-index:99999;max-width:340px;padding:10px 12px;' +
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
        titleMeta._title = inputId;
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

    function _findLabelFor(inputEl) {
        if (!inputEl || !inputEl.id) return null;
        if (!_hasDoc) return null;
        // Look for an explicit <label for=...> first
        var lbl = document.querySelector('label[for="' + inputEl.id + '"]');
        if (lbl) return lbl;
        // Fallback: the immediately preceding sibling <label>
        var p = inputEl.parentNode;
        if (p && p.querySelector) {
            var sib = p.querySelector('label');
            if (sib) return sib;
        }
        return null;
    }

    function _injectIconForId(inputId) {
        if (!_hasDoc) return false;
        var el = _$(inputId);
        if (!el) return false;
        if (_alreadyHasIcon(el)) return false;
        var icon = document.createElement('span');
        icon.className = ICON_CLASS;
        icon.setAttribute('role', 'button');
        icon.setAttribute('tabindex', '0');
        icon.setAttribute('aria-label', 'Help for ' + inputId);
        icon.setAttribute('data-wts-id', inputId);
        icon.setAttribute('data-wts-tooltip-anchor', inputId);
        icon.title = (REGISTRY[inputId] && REGISTRY[inputId].description) || 'Help';
        icon.innerHTML = 'i';
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
        _bindIcon(icon, inputId);
        return true;
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
//   and the global units toggle — each of which already stashes state
//   under window.WTS_state.<key> or window.PRiSM_*.
//
// PUBLIC API
//   window.WTS_project = {
//       save(filename?)         → Promise<{ blob, filename, payload }>
//       saveDownload(filename?) → triggers an <a download> click
//       load(file: File)        → Promise<{ loaded: [...], skipped: [...] }>
//       loadFromObject(obj)     → synchronous; same shape as load result
//       new()                   → wipe registered module state
//       info()                  → { modules: [...], modifiedAt, size }
//       registerModule(name, { read, write })
//       unregisterModule(name)
//       listModules()
//   };
//   window.WTS_renderProjectToolbar(container) → mounts the File toolbar
//
// FILE FORMAT (.h2oilproj — JSON)
//   {
//     "format":   "h2oilproj",
//     "version":  "1.0",
//     "generator":"H2Oil Well Testing Suite",
//     "savedAt":  "2026-04-28T12:34:56.789Z",
//     "modules":  { "<key>": <state>, ... },
//     "meta":     { client?, well?, field?, notes? }
//   }
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

        registerModule('prism', {
            read: function () {
                if (!G.PRiSM_state) return null;
                var subset = {
                    activeModel:    G.PRiSM_state.activeModel,
                    params:         _clone(G.PRiSM_state.params),
                    lastFit:        _clone(G.PRiSM_state.lastFit),
                    autoMatchTopN:  _clone(G.PRiSM_state.autoMatchTopN),
                    interp:         _clone(G.PRiSM_state.interp),
                    pvt:            _clone(G.PRiSM_state.pvt),
                    crop:           _clone(G.PRiSM_state.crop),
                    project:        _clone(G.PRiSM_state.project)
                };
                return subset;
            },
            write: function (state) {
                if (!state || typeof state !== 'object') return;
                if (!G.PRiSM_state || typeof G.PRiSM_state !== 'object') G.PRiSM_state = {};
                var s = G.PRiSM_state;
                for (var k in state) {
                    if (Object.prototype.hasOwnProperty.call(state, k)) {
                        s[k] = _clone(state[k]);
                    }
                }
            }
        });

        registerModule('prism_dataset', {
            read: function () {
                // Datasets can be huge — only persist when explicitly opted in.
                if (!G.PRiSM_dataset) return null;
                if (G.PRiSM_state && G.PRiSM_state.project &&
                    G.PRiSM_state.project.includeDataset === false) return null;
                return _clone(G.PRiSM_dataset);
            },
            write: function (state) {
                if (!state) return;
                G.PRiSM_dataset = _clone(state);
            }
        });

        registerModule('pvt', {
            read: function () {
                if (G.PRiSM_pvt) return _clone(G.PRiSM_pvt);
                if (G.WTS_state && G.WTS_state.pvt) return _clone(G.WTS_state.pvt);
                return null;
            },
            write: function (state) {
                if (!state) return;
                G.PRiSM_pvt = _clone(state);
                var s = _ensureWTSState();
                s.pvt = _clone(state);
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
    }
    _registerDefaults();

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
            meta:      meta || {},
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
        var mods = payload.modules || {};
        for (var k in mods) {
            if (!Object.prototype.hasOwnProperty.call(mods, k)) continue;
            if (!MODULES[k]) { skipped.push(k); continue; }
            try {
                MODULES[k].write(mods[k]);
                loaded.push(k);
            } catch (e) {
                _warn('module write failed for ' + k, e);
                skipped.push(k);
            }
        }
        return { loaded: loaded, skipped: skipped, error: null };
    }

    // ───────────────────────────────────────────────────────────────
    // Save — returns a Promise<{ blob, filename, payload }>
    // ───────────────────────────────────────────────────────────────
    function save(filename, meta) {
        try {
            var payload = _buildPayload(meta);
            var json = JSON.stringify(payload, null, 2);
            var blob = null;
            if (typeof G.Blob === 'function') {
                try { blob = new G.Blob([json], { type: 'application/json' }); }
                catch (e) { blob = null; }
            }
            var name = _slugify(filename || (payload.meta && payload.meta.well) ||
                                (payload.meta && payload.meta.well_name) || 'project') + '.h2oilproj';
            // In node (smoke-test) Blob won't exist — fall back to a stub object.
            if (!blob) blob = { size: json.length, type: 'application/json', _text: json };
            var res = { blob: blob, filename: name, payload: payload };
            if (typeof G.Promise === 'function') return G.Promise.resolve(res);
            return res;
        } catch (e) {
            _err('save() failed', e);
            if (typeof G.Promise === 'function') return G.Promise.reject(e);
            throw e;
        }
    }

    // ───────────────────────────────────────────────────────────────
    // saveDownload — clicks an <a download> programmatically
    // ───────────────────────────────────────────────────────────────
    function saveDownload(filename, meta) {
        try {
            var p = save(filename, meta);
            var apply = function (res) {
                if (!_hasDoc) return res;
                try {
                    var url = (G.URL && typeof G.URL.createObjectURL === 'function')
                        ? G.URL.createObjectURL(res.blob) : null;
                    var a = document.createElement('a');
                    a.href = url || ('data:application/json;charset=utf-8,' +
                        encodeURIComponent(JSON.stringify(res.payload, null, 2)));
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
                } catch (e) { _warn('saveDownload could not click', e); }
                return res;
            };
            if (p && typeof p.then === 'function') return p.then(apply);
            return apply(p);
        } catch (e) { _err('saveDownload failed', e); throw e; }
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

    function loadFromObject(obj) {
        return _applyPayload(obj);
    }

    // ───────────────────────────────────────────────────────────────
    // New — clear every registered module's state
    // ───────────────────────────────────────────────────────────────
    function newProject() {
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
            size:              size
        };
    }

    // ───────────────────────────────────────────────────────────────
    // File toolbar UI — New | Open | Save | Save As
    // ───────────────────────────────────────────────────────────────
    function renderProjectToolbar(container) {
        if (!_hasDoc || !container || !('innerHTML' in container)) return;

        // Idempotent — do not duplicate if already mounted in the host.
        var existing = (container.querySelector)
            ? container.querySelector('[data-wts-project-toolbar="1"]') : null;
        if (existing) return;

        var wrap = document.createElement('div');
        wrap.setAttribute('data-wts-project-toolbar', '1');
        wrap.style.cssText =
            'display:flex;align-items:center;gap:6px;padding:6px 10px;background:#161b22;' +
            'border:1px solid #30363d;border-radius:6px;font-family:Segoe UI,sans-serif;' +
            'font-size:12px;color:#c9d1d9';

        var btnStyle =
            'padding:4px 10px;background:#21262d;border:1px solid #30363d;border-radius:4px;' +
            'color:#c9d1d9;font-size:12px;cursor:pointer;line-height:1.4;font-family:inherit';
        var labelStyle = 'color:#8b949e;margin-right:6px;font-weight:600';

        wrap.innerHTML =
            '<span style="' + labelStyle + '">File:</span>' +
            '<button type="button" data-act="new"  style="' + btnStyle + '">New</button>' +
            '<button type="button" data-act="open" style="' + btnStyle + '">Open…</button>' +
            '<button type="button" data-act="save" style="' + btnStyle + '">Save</button>' +
            '<button type="button" data-act="saveas" style="' + btnStyle + '">Save As…</button>' +
            '<span data-role="status" style="margin-left:auto;color:#8b949e;font-size:11px"></span>' +
            '<input type="file" data-role="picker" accept=".h2oilproj,.json,application/json" ' +
            'style="display:none">';

        try { container.appendChild(wrap); } catch (e) { return; }

        function _setStatus(msg, kind) {
            var s = wrap.querySelector('[data-role="status"]');
            if (!s) return;
            var color = (kind === 'err') ? '#f85149' :
                        (kind === 'ok')  ? '#56d364' : '#8b949e';
            s.style.color = color;
            s.textContent = String(msg || '');
            if (msg && kind !== 'err') {
                setTimeout(function () {
                    if (s.textContent === msg) s.textContent = '';
                }, 4000);
            }
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
                ok = G.confirm('Clear all calculator state? Unsaved work will be lost.');
            }
            if (!ok) return;
            var res = newProject();
            _setStatus('Cleared ' + res.cleared.length + ' modules.', 'ok');
        });

        if (btnOpen && picker) {
            btnOpen.addEventListener('click', function () { picker.click(); });
            picker.addEventListener('change', function (ev) {
                var f = ev.target && ev.target.files && ev.target.files[0];
                if (!f) return;
                _setStatus('Loading ' + f.name + '…');
                load(f).then(function (res) {
                    if (res && res.error) {
                        _setStatus('Load failed: ' + res.error, 'err');
                    } else {
                        var ln = res ? (res.loaded || []).length : 0;
                        var sk = res ? (res.skipped || []).length : 0;
                        _setStatus('Loaded ' + ln + ' modules' +
                                   (sk ? ' (' + sk + ' skipped)' : ''), 'ok');
                    }
                    picker.value = '';
                }, function (err) {
                    _setStatus('Load failed: ' + (err && err.message ? err.message : err), 'err');
                    picker.value = '';
                });
            });
        }

        function _doSave(name) {
            try {
                saveDownload(name);
                _setStatus('Saved.', 'ok');
            } catch (e) {
                _setStatus('Save failed: ' + (e && e.message ? e.message : e), 'err');
            }
        }
        if (btnSave) btnSave.addEventListener('click', function () { _doSave(null); });
        if (btnSaveAs) btnSaveAs.addEventListener('click', function () {
            var def = 'project';
            try {
                var clientInfo = (G.WTS_state && G.WTS_state.clientInfo) ?
                                 G.WTS_state.clientInfo : null;
                if (clientInfo && clientInfo.wellName) def = _slugify(clientInfo.wellName);
            } catch (e) {}
            var nm = (typeof G.prompt === 'function')
                ? G.prompt('Save project as…', def) : def;
            if (nm) _doSave(nm);
        });
    }

    // ───────────────────────────────────────────────────────────────
    // Publish public API
    // ───────────────────────────────────────────────────────────────
    G.WTS_project = {
        save:             save,
        saveDownload:     saveDownload,
        load:             load,
        loadFromObject:   loadFromObject,
        'new':            newProject,   // reserved word — bracket-access from callers
        clearAll:         newProject,   // friendlier alias
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
//     • PRiSM Type-Curve Fit         (model, params, R², notes)
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
        { key: 'prism',      label: 'PRiSM Type-Curve Fit' }
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
            case 'prism':      return !!(G.PRiSM_state && (G.PRiSM_state.lastFit || G.PRiSM_state.activeModel));
            default:           return false;
        }
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
        var ci = (G.WTS_state && G.WTS_state.clientInfo) ? G.WTS_state.clientInfo : {};
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

    // ─── PRiSM Type-Curve Fit ──────────────────────────────────────
    function _renderPRiSM() {
        if (!_hasState('prism')) return _placeholder('PRiSM Type-Curve Fit');
        var ps = G.PRiSM_state || {};
        var fit = ps.lastFit || {};
        var rows = '';
        rows += _row('Active Model', ps.activeModel || fit.model || '—');
        rows += _row('R²', _fmt(fit.r2 || fit.R2, 4));
        rows += _row('RMSE', _fmt(fit.rmse, 3));
        rows += _row('AIC',  _fmt(fit.aic, 2));
        var params = fit.params || ps.params || {};
        var paramRows = '';
        var paramKeys = [];
        for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) paramKeys.push(k);
        if (paramKeys.length) {
            paramRows = '<h3 class="qr-h3">Fitted Parameters</h3>' +
                '<table class="qr-table"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>';
            for (var pi = 0; pi < paramKeys.length; pi++) {
                var pk = paramKeys[pi];
                var pv = params[pk];
                paramRows += '<tr><td>' + _esc(pk) + '</td><td>' +
                             (_isNum(pv) ? _fmt(pv, 4) : _esc(pv)) + '</td></tr>';
            }
            paramRows += '</tbody></table>';
        }
        var interp = (ps.interp && ps.interp.narrative) ?
            ('<p class="qr-rationale">' + _esc(ps.interp.narrative) + '</p>') : '';
        return _section('PRiSM Type-Curve Fit',
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

