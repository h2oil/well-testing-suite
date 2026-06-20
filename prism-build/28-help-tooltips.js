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
                          'wellboreStorage'];
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
