
// ═══════════════════════════════════════════════════════════════════════
// PRiSM Round-4 expansion — auto-injected from prism-build/
//   • 22-units              (Imperial/Metric toggle — global to suite)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ─── BEGIN 22-units ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// WTS — Layer 22 — App-wide Imperial / Metric Unit Toggle
//
// PURPOSE
//   A single global Imperial <-> Metric switch for the H2Oil Well
//   Testing Suite. Conversion is purely a UI-boundary concern:
//
//     USER types
//       -> DOM input.value (display system)
//          -> WTS_units reads
//             -> converts to canonical (imperial)
//                -> calculator runs as today (unchanged)
//                   -> canonical output
//                      -> WTS_units writes
//                         -> DOM output (display system)
//
//   The 35 calculator implementations stay 100% imperial. They are
//   never edited by this layer. Every tagged input gets an own 'value'
//   accessor: while a calculator runs (a "canonical context" — any
//   window.calc* / *Export call, or any input/change/click/key event
//   inside #pgBody) it returns the canonical imperial value; at all
//   other times it returns the text on screen. So live recalcs,
//   setTimeout(calc) after render and odd button labels are covered,
//   with no DOM swapping. Tagged outputs are converted when the
//   context closes.
//
// PUBLIC API (all on window.*)
//
//   WTS_units                                 — namespace object
//     .system                                 — 'imperial' | 'metric'
//     .setSystem(newSystem)                   — flips UI + persists
//     .getSystem()                            — returns current system
//     .convert(value, fromUnit, toUnit)       — pure unit-to-unit
//     .convertCategory(value, cat, from, to)  — category-aware convert
//     .format(canonicalValue, category)       — { value, unit, label }
//     .label(category)                        — string for current sys
//     .readInput(elementId)                   — returns canonical num
//     .readInputs(idList)                     — bulk read
//     .writeOutput(id, canonical, category)   — write display value
//     .writeOutputs(map)                      — bulk write
//     .tagInput(elementId, category)          — tag + label-rewrite
//     .tagOutput(elementId, category)         — tag for output walker
//     .applyManifest(routeName)               — tag fields for a route
//     .applyAllManifests()                    — tag every known field
//     .renderToggle(container)                — paint the toggle
//     .CATEGORIES                             — read-only reference
//     .MANIFEST                               — read-only reference
//
//   Custom event:
//     'wts:unit-system-changed'  fired on document, detail.system
//
//   localStorage:
//     'wts_unit_system' = 'imperial' | 'metric'
//
// CONVENTIONS
//   - Single outer IIFE, 'use strict'.
//   - Pure vanilla JS, no external deps.
//   - Defensive against missing DOM elements (every getElementById
//     call handles null).
//   - Idempotent — setSystem('metric') twice is a no-op the 2nd time.
//   - Hidden by default = no-op: if no toggle is rendered, every
//     calculator behaves exactly as it does today.
// ════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var G       = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    var STORAGE_KEY = 'wts_unit_system';

    // ───────────────────────────────────────────────────────────────
    // Tiny env shims
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

    // ───────────────────────────────────────────────────────────────
    // CATEGORY TABLE — defines imperial + metric units, conversion
    // factors, and pretty labels for every kind of dimensional value
    // used across the Well Testing Suite.
    //
    // Conversion model (per-side):
    //   For each side we store (factor, offset) such that
    //
    //       internal_metric_value = (display_value - offset) * factor
    //
    //   Inverse:
    //
    //       display_value = internal_metric_value / factor + offset
    //
    //   Examples:
    //     pressure imperial (psi):  metric_kPa = (psi - 0) * 6.89476
    //     pressure metric  (kPa):   metric_kPa = (kPa - 0) * 1
    //     temperature imperial:     C = (F - 32) * 5/9
    //     temperature metric:       C = (C - 0) * 1
    //
    //   For categories where the units are numerically identical
    //   (md/mD, cp/mPa·s, ppm, %, voltage, etc.) both factors = 1
    //   and tagging is harmless.
    //
    //   The metric side's factor is normally 1 (it IS the canonical
    //   metric reference), but for categories with no offset it's
    //   safe to use any consistent pair.
    // ───────────────────────────────────────────────────────────────
    var CATEGORIES = {
        // Pressure (gauge or absolute — both convert with the same
        // factor; no offset because we treat 0 as 0 in both systems).
        pressure: {
            imperial: { unit: 'psi',  label: 'psi',  factor: 6.89476, offset: 0 },
            metric:   { unit: 'kPa',  label: 'kPa',  factor: 1,       offset: 0 }
        },
        pressureG: {
            imperial: { unit: 'psig', label: 'psig', factor: 6.89476, offset: 0 },
            metric:   { unit: 'kPa',  label: 'kPa(g)', factor: 1,     offset: 0 }
        },
        pressureSmall: {
            imperial: { unit: 'inH2O', label: 'inH2O', factor: 2.49089, offset: 0 },
            metric:   { unit: 'mbar',  label: 'mbar',  factor: 1,       offset: 0 }
        },
        // Orifice-meter differential: inH2O at 60 °F (AGA-3 N3 = 27.707
        // inH2O/psi -> 68.94757/27.707 = 2.48845 mbar), not the 39.2 °F
        // column of pressureSmall (G2 verifier: -0.05 %).
        pressureSmall60: {
            imperial: { unit: 'inH2O', label: 'inH2O', factor: 2.48845, offset: 0 },
            metric:   { unit: 'mbar',  label: 'mbar',  factor: 1,       offset: 0 }
        },
        // Temperature with offset.
        temperature: {
            imperial: { unit: 'F',  label: '°F', factor: 5/9, offset: 32 },
            metric:   { unit: 'C',  label: '°C', factor: 1,   offset: 0 }
        },
        // Absolute temperature (no offset).
        tempAbsolute: {
            imperial: { unit: 'R',  label: '°R', factor: 5/9, offset: 0 },
            metric:   { unit: 'K',  label: 'K',  factor: 1,   offset: 0 }
        },
        // Length.
        length: {
            imperial: { unit: 'ft', label: 'ft', factor: 0.3048, offset: 0 },
            metric:   { unit: 'm',  label: 'm',  factor: 1,      offset: 0 }
        },
        lengthSmall: {
            imperial: { unit: 'in', label: 'in', factor: 25.4, offset: 0 },
            metric:   { unit: 'mm', label: 'mm', factor: 1,    offset: 0 }
        },
        // Tank dimensions — metric is ALWAYS centimetres (never a mix
        // of m and mm). Canonical reference is mm, same as lengthSmall.
        // Optional 'dp' = decimals kept when a value is converted on a
        // unit flip (2 dp in cm keeps x.xx in -> cm exact: 1 in = 2.54 cm).
        lengthCm: {
            imperial: { unit: 'in', label: 'in', factor: 25.4,  offset: 0, dp: 4 },
            metric:   { unit: 'cm', label: 'cm', factor: 10,    offset: 0, dp: 2 }
        },
        lengthFtCm: {
            imperial: { unit: 'ft', label: 'ft', factor: 304.8, offset: 0, dp: 4 },
            metric:   { unit: 'cm', label: 'cm', factor: 10,    offset: 0, dp: 2 }
        },
        // Area.
        area: {
            imperial: { unit: 'ft2', label: 'ft²', factor: 0.092903, offset: 0 },
            metric:   { unit: 'm2',  label: 'm²',  factor: 1,        offset: 0 }
        },
        // Volume.
        volume: {
            imperial: { unit: 'bbl', label: 'bbl', factor: 0.158987, offset: 0 },
            metric:   { unit: 'm3',  label: 'm³',  factor: 1,        offset: 0 }
        },
        volumeSmall: {
            imperial: { unit: 'gal', label: 'gal', factor: 3.78541, offset: 0 },
            metric:   { unit: 'L',   label: 'L',   factor: 1,       offset: 0 }
        },
        // Gas volume / rate (canonical = m³, so MMSCF -> 28316.8 m³;
        // the metric unit is 1000 m³, so factor on metric = 1000). Label
        // "10³ m³" — "Mm³" reads as million m³ (audit G2).
        gasVolume: {
            imperial: { unit: 'MMSCF', label: 'MMSCF',  factor: 28316.8, offset: 0 },
            metric:   { unit: 'Mm3',   label: '10³ m³', factor: 1000,    offset: 0 }
        },
        gasRate: {
            imperial: { unit: 'MMSCFD', label: 'MMSCFD',   factor: 28316.8, offset: 0 },
            metric:   { unit: 'Mm3/d',  label: '10³ m³/d', factor: 1000,    offset: 0 }
        },
        gasRateSmall: {
            imperial: { unit: 'MSCFD', label: 'MSCFD', factor: 28.3168, offset: 0 },
            metric:   { unit: 'm3/d',  label: 'm³/d',  factor: 1,       offset: 0 }
        },
        // Liquid rate.
        liquidRate: {
            imperial: { unit: 'bbl/d', label: 'BPD',  factor: 0.158987, offset: 0 },
            metric:   { unit: 'm3/d',  label: 'm³/d', factor: 1,        offset: 0 }
        },
        // Pipe capacity (volume per length): bbl/ft <-> m³/m.
        capacity: {
            imperial: { unit: 'bbl/ft', label: 'bbl/ft', factor: 0.158987294928 / 0.3048, offset: 0 },
            metric:   { unit: 'm3/m',   label: 'm³/m',   factor: 1,                        offset: 0 }
        },
        liquidRateSmall: {
            imperial: { unit: 'gal/min', label: 'gpm',   factor: 3.78541, offset: 0 },
            metric:   { unit: 'L/min',   label: 'L/min', factor: 1,       offset: 0 }
        },
        // Mass.
        mass: {
            imperial: { unit: 'lb', label: 'lb', factor: 0.453592, offset: 0 },
            metric:   { unit: 'kg', label: 'kg', factor: 1,        offset: 0 }
        },
        // Short ton (2000 lb) <-> metric tonne.
        massTon: {
            imperial: { unit: 'ton', label: 'tons',   factor: 907.18474, offset: 0 },
            metric:   { unit: 't',   label: 'tonnes', factor: 1000,      offset: 0 }
        },
        massRate: {
            imperial: { unit: 'lb/hr', label: 'lb/hr', factor: 0.453592, offset: 0 },
            metric:   { unit: 'kg/hr', label: 'kg/hr', factor: 1,        offset: 0 }
        },
        // Density.
        density: {
            imperial: { unit: 'lb/ft3', label: 'lb/ft³', factor: 16.0185, offset: 0 },
            metric:   { unit: 'kg/m3',  label: 'kg/m³',  factor: 1,       offset: 0 }
        },
        densityLiquid: {
            imperial: { unit: 'lb/gal', label: 'ppg',  factor: 0.119826, offset: 0 },
            metric:   { unit: 'kg/L',   label: 'kg/L', factor: 1,        offset: 0 }
        },
        // Viscosity (numerically identical in both systems).
        viscosity: {
            imperial: { unit: 'cp',   label: 'cp',    factor: 1, offset: 0 },
            metric:   { unit: 'mPas', label: 'mPa·s', factor: 1, offset: 0 }
        },
        // Velocity.
        velocity: {
            imperial: { unit: 'ft/s', label: 'ft/s', factor: 0.3048, offset: 0 },
            metric:   { unit: 'm/s',  label: 'm/s',  factor: 1,      offset: 0 }
        },
        // Permeability — md and mD are numerically identical.
        permeability: {
            imperial: { unit: 'md', label: 'md', factor: 1, offset: 0 },
            metric:   { unit: 'mD', label: 'mD', factor: 1, offset: 0 }
        },
        permThickness: {
            imperial: { unit: 'mdft', label: 'md·ft', factor: 0.3048, offset: 0 },
            metric:   { unit: 'mDm',  label: 'mD·m',  factor: 1,      offset: 0 }
        },
        // Compressibility — 1/pressure inverts (1/psi to 1/kPa
        // divides by 6.89476).
        compressibility: {
            imperial: { unit: '1/psi', label: '1/psi', factor: 1 / 6.89476, offset: 0 },
            metric:   { unit: '1/kPa', label: '1/kPa', factor: 1,           offset: 0 }
        },
        // Power.
        power: {
            imperial: { unit: 'hp', label: 'hp', factor: 0.7457, offset: 0 },
            metric:   { unit: 'kW', label: 'kW', factor: 1,      offset: 0 }
        },
        powerLarge: {
            imperial: { unit: 'MMBTU/hr', label: 'MMBtu/hr', factor: 293.071, offset: 0 },
            metric:   { unit: 'kW',       label: 'kW',       factor: 1,       offset: 0 }
        },
        // Energy.
        energy: {
            imperial: { unit: 'Btu', label: 'Btu', factor: 1.05506, offset: 0 },
            metric:   { unit: 'kJ',  label: 'kJ',  factor: 1,       offset: 0 }
        },
        // Heating value (energy per gas volume).
        heatingValue: {
            imperial: { unit: 'BTU/SCF', label: 'BTU/SCF', factor: 0.0372589, offset: 0 },
            metric:   { unit: 'MJ/m3',   label: 'MJ/m³',   factor: 1,         offset: 0 }
        },
        // Force.
        force: {
            imperial: { unit: 'lbf', label: 'lbf', factor: 4.44822, offset: 0 },
            metric:   { unit: 'N',   label: 'N',   factor: 1,       offset: 0 }
        },
        // Torque.
        torque: {
            imperial: { unit: 'lbfft', label: 'lbf·ft', factor: 1.35582, offset: 0 },
            metric:   { unit: 'Nm',    label: 'N·m',    factor: 1,       offset: 0 }
        },
        // Radiation flux.
        radiation: {
            imperial: { unit: 'Btu/hr/ft2', label: 'Btu/hr/ft²', factor: 0.003154, offset: 0 },
            metric:   { unit: 'kW/m2',      label: 'kW/m²',      factor: 1,        offset: 0 }
        },
        heatTransfer: {
            imperial: { unit: 'Btu/hr/F', label: 'Btu/hr/°F', factor: 0.5275, offset: 0 },
            metric:   { unit: 'W/K',      label: 'W/K',       factor: 1,      offset: 0 }
        },
        // Voltage / current / frequency / count — no conversion needed.
        voltage:    { imperial: { unit: 'V',   label: 'V',   factor: 1, offset: 0 }, metric: { unit: 'V',   label: 'V',   factor: 1, offset: 0 } },
        current:    { imperial: { unit: 'A',   label: 'A',   factor: 1, offset: 0 }, metric: { unit: 'A',   label: 'A',   factor: 1, offset: 0 } },
        currentSm:  { imperial: { unit: 'mA',  label: 'mA',  factor: 1, offset: 0 }, metric: { unit: 'mA',  label: 'mA',  factor: 1, offset: 0 } },
        frequency:  { imperial: { unit: 'Hz',  label: 'Hz',  factor: 1, offset: 0 }, metric: { unit: 'Hz',  label: 'Hz',  factor: 1, offset: 0 } },
        powerFactor:{ imperial: { unit: 'pf',  label: '',    factor: 1, offset: 0 }, metric: { unit: 'pf',  label: '',    factor: 1, offset: 0 } },
        powerKw:    { imperial: { unit: 'kW',  label: 'kW',  factor: 1, offset: 0 }, metric: { unit: 'kW',  label: 'kW',  factor: 1, offset: 0 } },
        // Concentration / dimensionless / sg / api.
        concentration: { imperial: { unit: 'ppm', label: 'ppm', factor: 1, offset: 0 }, metric: { unit: 'ppm', label: 'ppm', factor: 1, offset: 0 } },
        percent:       { imperial: { unit: '%',   label: '%',   factor: 1, offset: 0 }, metric: { unit: '%',   label: '%',   factor: 1, offset: 0 } },
        sg:            { imperial: { unit: 'sg',  label: '',    factor: 1, offset: 0 }, metric: { unit: 'sg',  label: '',    factor: 1, offset: 0 } },
        api:           { imperial: { unit: 'API', label: '°API', factor: 1, offset: 0 }, metric: { unit: 'API', label: '°API', factor: 1, offset: 0 } },
        dimensionless: { imperial: { unit: '',    label: '',    factor: 1, offset: 0 }, metric: { unit: '',    label: '',    factor: 1, offset: 0 } },
        count:         { imperial: { unit: '',    label: '',    factor: 1, offset: 0 }, metric: { unit: '',    label: '',    factor: 1, offset: 0 } },
        // Acoustic / engineering ratios.
        noise:    { imperial: { unit: 'dBA',  label: 'dBA',  factor: 1, offset: 0 }, metric: { unit: 'dBA',  label: 'dBA',  factor: 1, offset: 0 } },
        ratio:    { imperial: { unit: '',     label: '',     factor: 1, offset: 0 }, metric: { unit: '',     label: '',     factor: 1, offset: 0 } },
        // Gas-oil ratio: 1 scf/STB = 0.0283168 m³ / 0.158987 m³ = 0.178108 sm³/sm³.
        gor:      { imperial: { unit: 'scf/stb', label: 'SCF/STB', factor: 0.0283168466 / 0.158987294928, offset: 0 }, metric: { unit: 'sm3/sm3', label: 'sm³/sm³', factor: 1, offset: 0 } },
        // Condensate-gas ratio: 1 bbl/MMscf = 0.158987 m³ / 28316.8 m³ = 5.61458 m³/10⁶ m³.
        cgr:      { imperial: { unit: 'bbl/MMscf', label: 'bbl/MMscf', factor: 0.158987294928 / 28316.8466 * 1e6, offset: 0 }, metric: { unit: 'm3/1e6m3', label: 'm³/10⁶ m³', factor: 1, offset: 0 } },
        time:     { imperial: { unit: 'hr',   label: 'hr',   factor: 1, offset: 0 }, metric: { unit: 'hr',   label: 'hr',   factor: 1, offset: 0 } },
        timeMin:  { imperial: { unit: 'min',  label: 'min',  factor: 1, offset: 0 }, metric: { unit: 'min',  label: 'min',  factor: 1, offset: 0 } },
        // Mass-flow specific to compressors (SCFM): no conversion (pure rate).
        airFlow:  { imperial: { unit: 'SCFM', label: 'SCFM', factor: 1, offset: 0 }, metric: { unit: 'SCFM', label: 'SCFM', factor: 1, offset: 0 } }
    };

    // ───────────────────────────────────────────────────────────────
    // CONVERSION CORE
    //
    // _convertValue(v, fromCfg, toCfg)
    //   Generic offset+factor conversion via a canonical metric
    //   reference. Both sides specify (factor, offset) such that
    //
    //     metric_canonical = (display - offset) * factor
    //     display          = metric_canonical / factor + offset
    //
    //   So to convert FROM the from-side TO the to-side:
    //     1. intermediate = (value - fromCfg.offset) * fromCfg.factor
    //                       (now a metric-canonical number)
    //     2. result       = intermediate / toCfg.factor + toCfg.offset
    // ───────────────────────────────────────────────────────────────
    function _convertValue(value, fromCfg, toCfg) {
        if (typeof value !== 'number' || !isFinite(value)) return NaN;
        if (!fromCfg || !toCfg) return value;
        // From -> metric canonical.
        var intermediate = (value - (fromCfg.offset || 0)) * (fromCfg.factor || 1);
        // Metric canonical -> To.
        var result = intermediate / (toCfg.factor || 1) + (toCfg.offset || 0);
        return result;
    }

    function convertCategory(value, category, fromSystem, toSystem) {
        if (fromSystem === toSystem) return value;
        var cat = CATEGORIES[category];
        if (!cat) {
            _warn('[WTS_units] Unknown category:', category);
            return value;
        }
        var fromCfg = cat[fromSystem];
        var toCfg   = cat[toSystem];
        if (!fromCfg || !toCfg) {
            _warn('[WTS_units] Missing system config for', category, fromSystem, toSystem);
            return value;
        }
        return _convertValue(value, fromCfg, toCfg);
    }

    // Unit-name based convert. Look the unit up across all categories
    // (first match wins). Useful for one-off conversions where caller
    // has a free-form unit name.
    function convertByUnit(value, fromUnit, toUnit) {
        if (fromUnit === toUnit) return value;
        var fromCfg = null, toCfg = null;
        var keys = Object.keys(CATEGORIES);
        for (var i = 0; i < keys.length; i++) {
            var cat = CATEGORIES[keys[i]];
            if (!fromCfg) {
                if (cat.imperial && cat.imperial.unit === fromUnit) fromCfg = cat.imperial;
                else if (cat.metric && cat.metric.unit === fromUnit) fromCfg = cat.metric;
            }
            if (!toCfg) {
                if (cat.imperial && cat.imperial.unit === toUnit) toCfg = cat.imperial;
                else if (cat.metric && cat.metric.unit === toUnit) toCfg = cat.metric;
            }
            if (fromCfg && toCfg) break;
        }
        if (!fromCfg || !toCfg) return value;
        return _convertValue(value, fromCfg, toCfg);
    }

    // ───────────────────────────────────────────────────────────────
    // MANIFEST — every input/output ID we know about, mapped to its
    // unit category. Built by walking the host HTML's render*
    // functions. Outputs are mostly dynamic so we focus on inputs;
    // the calculate-button wrapper does live conversion of inputs
    // and we let calculators write outputs in canonical (imperial)
    // units, then post-convert any tagged outputs.
    //
    // PRIORITY tier 1 (full coverage): wts, flare, aga3, choke,
    //   chokeflow, dca, pta, gascalc, fluid, tank, vessel, sep,
    //   seprate, sephand, heater, pipesz.
    //
    // TIER 2: oilgas, mcfshr, casing, chokecnv, analogsig, pumpsz,
    //   bottomsup, solgor, elec, chem, prv, turbmeter, aircomp,
    //   gensz, cablesz, vdrop, flamearr, arc.
    //
    // (UnitsConverter, ReleaseNotes, GAEvents, ClientInfo, Home,
    // PRiSM are intentionally left out — either they have no inputs
    // needing conversion, or they're already-bilingual or
    // count-based.)
    // ───────────────────────────────────────────────────────────────
    var MANIFEST = {
        wts: {
            inputs: {
                wts_Pwh:     'pressureG',
                wts_Twh:     'temperature',
                wts_Qg:      'gasRate',
                wts_Qo:      'liquidRate',
                wts_Qw:      'liquidRate',
                wts_SGg:     'sg',
                wts_API:     'api',
                wts_bean:    'count',
                wts_Cd:      'dimensionless',
                wts_Thtr:    'temperature',
                wts_htrEff:  'percent',
                wts_Psep:    'pressureG',
                wts_Cfac:    'dimensionless',  // C-factor (API RP 14E)
                wts_eps:     'lengthSmall',    // pipe roughness in inches
                wts_len1: 'length', wts_len2: 'length', wts_len3: 'length',
                wts_len4: 'length', wts_len5: 'length', wts_len6: 'length'
            },
            outputs: {}
        },
        aga3: {
            inputs: {
                a_pD:   'lengthSmall',
                a_oD:   'lengthSmall',
                a_dP:   'pressureSmall60',  // inH2O @ 60 °F (N3 = 27.707, as the calc)
                a_Ps:   'pressureG',
                a_Tf:   'temperature',
                a_SG:   'sg',
                a_CO2:  'percent',
                a_H2S:  'percent',
                a_N2:   'percent',
                a_Tb:   'temperature',
                a_Pb:   'pressure'
            },
            outputs: {}
        },
        choke: {
            inputs: {
                c_P1:   'pressureG',   // dual choke inputs are gauge (G1 audit)
                c_P3:   'pressureG',
                c_T:    'temperature',
                c_s1:   'count',
                c_cd1:  'dimensionless',
                c_s2:   'count',
                c_cd2:  'dimensionless',
                c_SG:   'sg',
                c_API:  'api',
                c_GOR:  'gor',
                c_WC:   'percent'
            },
            outputs: {}
        },
        // Flare is authored natively in mixed units (MMSCFD + BTU/SCF,
        // everything else SI: m, m/s, °C, kW/m²) and reads its inputs
        // from closures (getFlameParams) driven by requestAnimationFrame,
        // canvas drag/wheel and resize — paths no canonical context can
        // cover. Tagging the SI fields as imperial-canonical made BOTH
        // modes lie (Imperial: "Ambient Temp (°F)" holding °C numbers;
        // Metric: 25 °C shown as -3.9 °C). Left untagged: the page shows
        // its native units in both systems and every path stays correct.
        flare: {
            inputs: {},
            outputs: {}
        },
        dca: {
            inputs: {
                d_qi:  'dimensionless',  // rate units selected via d_unit dropdown
                d_di:  'dimensionless',
                d_b:   'dimensionless',
                d_a:   'dimensionless',
                d_m:   'dimensionless',
                d_tau: 'timeMin',
                d_n:   'dimensionless',
                d_fm:  'timeMin'
            },
            outputs: {}
        },
        pta: {
            inputs: {
                p_tp:  'time',
                p_q:   'liquidRate',
                p_Bo:  'dimensionless',
                p_mu:  'viscosity',
                p_h:   'length',
                p_ct:  'compressibility',
                p_phi: 'dimensionless',
                p_rw:  'length',
                p_pwf: 'pressure'
            },
            outputs: {}
        },
        prv: {
            inputs: {
                pg_ps:  'pressureG',
                pg_pb:  'pressureG',
                pg_t:   'temperature',
                pg_mw:  'dimensionless',
                pg_k:   'dimensionless',
                pg_z:   'dimensionless',
                pg_w:   'massRate',
                ps_ps:  'pressureG',
                ps_pb:  'pressureG',
                ps_t:   'temperature',
                ps_w:   'massRate',
                pl_ps:  'pressureG',
                pl_pb:  'pressureG',
                pl_q:   'liquidRateSmall', // gpm
                pl_sg:  'sg',
                pl_mu:  'viscosity'
            },
            outputs: {}
        },
        chokeflow: {
            inputs: {
                cf_cs:  'count',
                cf_whp: 'pressureG',
                cf_wht: 'temperature',
                cf_sg:  'sg',
                cf_op:  'pressureG',
                cf_ocs: 'count',
                cf_gor: 'gor'
            },
            outputs: {}
        },
        gascalc: {
            inputs: {
                gv_z:   'dimensionless',
                gv_t:   'temperature',
                gv_p:   'pressure',
                gv_q:   'gasRateSmall',  // MSCF/D
                gv_d:   'lengthSmall',
                gq_p:   'pressure',
                gq_d:   'count',         // 64ths
                gg_pwh: 'pressure',
                gg_sg:  'sg',
                gg_d:   'length',
                gg_t:   'tempAbsolute',
                gg_z:   'dimensionless',
                gs_p:   'pressure',
                gs_sg:  'sg',
                gs_t:   'tempAbsolute',
                gs_z:   'dimensionless'
            },
            outputs: {}
        },
        fluid: {
            inputs: {
                fp_api:  'api',
                fp_t:    'temperature',
                fp_sg:   'sg',
                fp_api2: 'api',
                // Bubble Point and Shrinkage tabs (audit G2: were untagged).
                bp_api:  'api',
                bp_gor:  'gor',
                bp_gg:   'sg',
                bp_st:   'temperature',
                bp_sp:   'pressureG',
                bp_rt:   'temperature',
                sf_sp:   'pressureG',
                sf_st:   'temperature',
                sf_gg:   'sg',
                sf_api:  'api'
            },
            outputs: {}
        },
        tank: {
            inputs: {
                // Every tank dimension is cm in metric (in / ft imperial).
                tr_h:    'lengthCm',
                tr_l:    'lengthCm',
                tr_w:    'lengthCm',
                tr_fl:   'lengthCm',
                tv_d:    'lengthCm',
                tv_h:    'lengthCm',
                tv_fl:   'lengthCm',
                tc_d:    'lengthCm',
                tc_l:    'lengthFtCm',    // feet in imperial
                tc_fl:   'lengthCm',
                tk_v1:   'volume',
                tk_v2:   'volume',
                tk_t1:   'time',
                tk_t2:   'time',
                tw_ppg:  'densityLiquid',
                tw_gal:  'volumeSmall',
                tw_tare: 'massTon',       // short tons <-> tonnes
                tw_area: 'area'
            },
            outputs: {}
        },
        vessel: {
            inputs: {
                vs_p:  'pressure',
                vs_r:  'lengthSmall',
                vs_s:  'pressure',
                vs_e:  'dimensionless',
                vs_ca: 'lengthSmall',
                vh_p:  'pressure',
                vh_d:  'lengthSmall',
                vh_s:  'pressure',
                vh_e:  'dimensionless',
                vh_ca: 'lengthSmall'
            },
            outputs: {}
        },
        elec: {
            inputs: {
                el_v:   'voltage',
                el_kw:  'powerKw',
                el_pf:  'powerFactor',
                el_kw2: 'powerKw',
                // el_hp is the HP side of the kW <-> HP converter — must
                // stay HP in both systems (was relabelled "(kW)" in metric).
                mp_d:   'lengthSmall',
                mp_sl:  'lengthSmall',
                mp_eff: 'percent',
                // strokes/min — unit-free count ('frequency' appended "(Hz)").
                mp_spm: 'count',
                mp_n:   'count'
            },
            outputs: {}
        },
        chem: {
            inputs: {
                ch_q:   'liquidRate',
                ch_ppm: 'concentration'
                // cl_a / cl_b / cl_d are titration volumes in ml and cl_n
                // is a normality — unit-free in both systems. (They were
                // tagged gal<->L / ppm, which relabelled "(ml)" as "(gal)"
                // and converted 29.3 ml to "110.9 L" in metric.)
            },
            outputs: {}
        },
        sep: {
            inputs: {
                sp_cap: 'volume',
                sp_lvl: 'percent',
                sp_q:   'liquidRate'
            },
            outputs: {}
        },
        bottomsup: {
            inputs: {
                bu_q:   'liquidRate',
                bu_vol: 'volume'
            },
            outputs: {}
        },
        solgor: {
            inputs: {
                sg_p:   'pressureG',
                sg_t:   'temperature',
                sg_gg:  'sg',
                sg_api: 'api'
            },
            outputs: {}
        },
        oilgas: {
            inputs: {
                og_int:   'timeMin',
                og_api:   'api',
                og_ht:    'temperature',
                og_m0:    'volume',
                og_m1:    'volume',
                og_olt:   'temperature',
                og_bsw:   'percent',
                og_mf:    'dimensionless',
                og_sf:    'dimensionless',
                og_run:   'lengthSmall',
                og_plate: 'lengthSmall',
                og_sp:    'pressureG',
                og_dp:    'pressureSmall60',  // inH2O @ 60 °F (N3 = 27.707)
                og_gg:    'sg',
                og_gt:    'temperature'
            },
            outputs: {}
        },
        mcfshr: {
            inputs: {
                ms_ti: 'volume',
                ms_tf: 'volume',
                ms_si: 'volume',
                ms_sf: 'volume',
                ms_ss: 'volume'
            },
            outputs: {}
        },
        casing: {
            inputs: {
                ct_cl: 'length',
                ct_tl: 'length'
            },
            outputs: {}
        },
        chokecnv: {
            inputs: {
                // Choke conversions are unit-conversion themselves —
                // do not retag (they live across systems already).
            },
            outputs: {}
        },
        analogsig: {
            inputs: {
                as_val: 'dimensionless',
                as_lo:  'dimensionless',
                as_hi:  'dimensionless'
            },
            outputs: {}
        },
        pumpsz: {
            inputs: {
                ps_q:   'liquidRate',
                ps_api: 'api',
                ps_mu:  'viscosity',
                // ps_t (°C) and ps_hs/ps_hd/ps_ls/ps_ld (m) are SI in the
                // calc — left untagged so both systems show their native
                // units. (NB ps_t / ps_ps ids also exist on PRV, where ps_t
                // is °F — tagging is route-scoped so they don't collide.)
                ps_ps:  'pressureG',
                ps_pd:  'pressureG',
                ps_eff: 'percent',
                ps_vp:  'pressure'
            },
            outputs: {}
        },
        seprate: {
            inputs: {
                sr_id:  'lengthSmall',
                sr_len: 'length',
                sr_nll: 'percent',
                sr_p:   'pressureG',
                sr_t:   'temperature',
                sr_qo:  'liquidRate',
                sr_qg:  'gasRate',
                sr_api: 'api',
                sr_gsg: 'sg',
                sr_bsw: 'percent'
            },
            outputs: {}
        },
        sephand: {
            inputs: {
                sh_id:     'lengthSmall',
                sh_len:    'length',
                sh_nll:    'percent',
                sh_hhll:   'percent',
                sh_oilfrac:'percent',
                sh_p:      'pressureG',
                sh_pd:     'pressureG',
                // sh_t is °C in the calc (T_C) — left untagged (native
                // °C in both systems; tagging it imperial-canonical made
                // 40 °C display as 4.4 °C in metric and "(°F)" in imperial).
                sh_zman:   'dimensionless',
                sh_qo:     'liquidRate',
                sh_qg:     'gasRate',
                sh_gsg:    'sg',
                sh_api:    'api',
                sh_bsw:    'percent',
                sh_gpcv:   'lengthSmall',
                sh_gline:  'lengthSmall',
                sh_gdan:   'lengthSmall',
                sh_olcv:   'lengthSmall',
                sh_oline:  'lengthSmall',
                sh_oturb:  'lengthSmall',
                sh_wlcv:   'lengthSmall',
                sh_wline:  'lengthSmall',
                sh_wturb:  'lengthSmall',
                sh_dplcv:  'pressure',
                sh_travel: 'percent'
            },
            outputs: {}
        },
        heater: {
            inputs: {
                ih_q:   'liquidRate',
                ih_api: 'api',
                // ih_ti / ih_to are °C in the calc — left untagged.
                ih_wc:  'percent',
                ih_eff: 'percent'
            },
            outputs: {}
        },
        pipesz: {
            inputs: {
                pp_p:  'pressureG',
                pp_l:  'length',
                pp_ql: 'liquidRate',
                pp_qg: 'gasRate',
                pp_sg: 'sg'
            },
            outputs: {}
        },
        flamearr: {
            inputs: {
                fa_mw: 'dimensionless',
                fa_q:  'gasRateSmall',  // MSCFD
                // fa_t is °C in the calc — left untagged.
                fa_p:  'pressureG',
                fa_dp: 'pressure'
            },
            outputs: {}
        },
        arc: {
            inputs: {
                av_qn:   'liquidRate',
                av_qmin: 'liquidRate',
                av_api:  'api',
                av_pso:  'pressureG',
                av_pdn:  'pressureG',
                av_ret:  'pressureG'
            },
            outputs: {}
        },
        turbmeter: {
            inputs: {
                tm_api:  'api',
                // tm_t is °C in the calc — left untagged.
                tm_mu:   'viscosity',
                tm_qmin: 'liquidRate',
                tm_qmax: 'liquidRate',
                tm_p:    'pressureG'
            },
            outputs: {}
        },
        aircomp: {
            inputs: {
                ac_q: 'airFlow',
                ac_p: 'pressureG'
            },
            outputs: {}
        },
        gensz: {
            inputs: {
                gs_nm: 'powerKw',
                gs_pf: 'powerFactor',
                gs_v:  'voltage'
            },
            outputs: {}
        },
        cablesz: {
            inputs: {
                cs_v:   'voltage',
                cs_i:   'current',
                cs_pf:  'powerFactor'
                // cs_l (m) and cs_amb (°C) are SI in the calc — untagged.
            },
            outputs: {}
        },
        vdrop: {
            inputs: {
                vd_v:  'voltage',
                vd_i:  'current',
                vd_pf: 'powerFactor'
                // vd_l (m) is SI in the calc — untagged.
            },
            outputs: {}
        }
    };

    // ───────────────────────────────────────────────────────────────
    // STATE
    // ───────────────────────────────────────────────────────────────
    var _state = {
        system: 'imperial'
    };

    function _readPersisted() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage.getItem) {
                var v = localStorage.getItem(STORAGE_KEY);
                if (v === 'imperial' || v === 'metric') return v;
            }
        } catch (e) {}
        return 'imperial';
    }

    function _writePersisted(system) {
        try {
            if (typeof localStorage !== 'undefined' && localStorage.setItem) {
                localStorage.setItem(STORAGE_KEY, system);
            }
        } catch (e) {}
    }

    _state.system = _readPersisted();

    function getSystem() { return _state.system; }

    // ───────────────────────────────────────────────────────────────
    // FORMATTING
    // ───────────────────────────────────────────────────────────────
    function _format(canonicalValue, category) {
        var cat = CATEGORIES[category];
        if (!cat) return { value: canonicalValue, unit: '', label: '' };
        var sys = _state.system;
        var displayValue = (sys === 'imperial')
            ? canonicalValue
            : convertCategory(canonicalValue, category, 'imperial', 'metric');
        return {
            value: displayValue,
            unit:  cat[sys].unit,
            label: cat[sys].label
        };
    }

    function _label(category) {
        var cat = CATEGORIES[category];
        if (!cat) return '';
        return cat[_state.system].label;
    }

    // Rounding applied when an input is flipped between systems. A
    // category side may pin its decimals via 'dp'; otherwise the
    // legacy rule (1 dp at >= 100, else 4 dp) applies.
    function _roundForDisplay(value, category, system) {
        var cat = CATEGORIES[category];
        var cfg = cat && cat[system];
        if (cfg && typeof cfg.dp === 'number') return Number(value.toFixed(cfg.dp));
        return (Math.abs(value) >= 100) ? Number(value.toFixed(1)) : Number(value.toFixed(4));
    }

    // Convert one input element's displayed value fromSys -> toSys.
    // Exact round-trip: the pre-conversion text is remembered on the
    // node, and if the field is still showing exactly what we wrote
    // when it is flipped back, the original text is restored instead
    // of re-converting a rounded number (so imperial -> metric ->
    // imperial always returns the user's original numbers).
    // Machine-precision text (a stored canonical such as 1450.37680789,
    // produced by a metric -> imperial conversion) is shown to 7
    // significant digits. Human-typed numbers never reach 8 decimals,
    // so they — and small legitimate values like 0.00015 — are untouched.
    function _tidyText(s) {
        s = String(s);
        return /^-?\d+\.\d{8,}$/.test(s) ? String(Number(parseFloat(s).toPrecision(7))) : s;
    }

    // NB: __wts_memo = { cat, sys, orig, shown } is also read by the
    // host's universal page autosave (__ctrlValue) — keep its meaning.
    function _convertInputEl(el, cat, fromSys, toSys) {
        if (!el || fromSys === toSys) return;
        var cur = String(_nget(el));
        var memo = el.__wts_memo;
        if (memo && memo.cat === cat && memo.sys === toSys && memo.shown === cur) {
            try { _nset(el, _tidyText(memo.orig)); } catch (e) { return; }
            el.__wts_memo = { cat: cat, sys: fromSys, orig: cur, shown: String(_nget(el)) };
            return;
        }
        var raw = parseFloat(cur);
        if (!isFinite(raw)) return;
        var converted = convertCategory(raw, cat, fromSys, toSys);
        if (typeof converted !== 'number' || !isFinite(converted)) return;
        try { _nset(el, _roundForDisplay(converted, cat, toSys)); } catch (e) { return; }
        el.__wts_memo = { cat: cat, sys: fromSys, orig: cur, shown: String(_nget(el)) };
    }

    // ───────────────────────────────────────────────────────────────
    // CANONICAL CONTEXT
    //
    // Contract for every tagged input (data-wts-unit-cat):
    //   • OUTSIDE a canonical context, el.value is the text on screen
    //     (display system) — what autosave, page export / reports and
    //     any WYSIWYG reader expect.
    //   • INSIDE a canonical context, el.value returns the canonical
    //     imperial value the calculators were written for, and an
    //     assignment is taken as canonical and shown converted.
    //
    // A context is open while (a) any window.calc* / *Export(CSV|PDF)
    // function runs — they are wrapped, so button clicks, live
    // input/change recalcs, setTimeout(calc…) after render and calls
    // from other modules are all covered; (b) any input / change /
    // click / key event is being dispatched inside #pgBody (listeners
    // on #pgBody capture + bubble, so document-level listeners such as
    // autosave run outside it); (c) WTS_units.runCanonical(fn) runs.
    // Nothing is written to the DOM to achieve this (each tagged input
    // gets an own 'value' accessor that consults the context depth), so
    // there is no caret jump, no flicker, and nesting (a wrapped calc
    // called from a wrapped calc / event) can never double-convert.
    // ───────────────────────────────────────────────────────────────
    var _inDesc = null;
    try {
        if (typeof HTMLInputElement !== 'undefined' && HTMLInputElement.prototype) {
            _inDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') || null;
        }
    } catch (e) { _inDesc = null; }
    function _isInputEl(el) {
        return !!(_inDesc && _inDesc.get && typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement);
    }
    // Native (display) accessors — bypass the per-element accessor.
    function _nget(el) { return _isInputEl(el) ? _inDesc.get.call(el) : el.value; }
    function _nset(el, v) { if (_isInputEl(el)) _inDesc.set.call(el, v); else el.value = v; }

    var _ctxDepth = 0;
    function _enterCanonical() { _ctxDepth++; return { done: false }; }
    function _exitCanonical(tok) {
        if (!tok || tok.done) return;
        tok.done = true;
        if (_ctxDepth > 0) _ctxDepth--;
        if (_ctxDepth === 0) { try { _syncTaggedOutputs(false); } catch (e) {} }
    }
    function runCanonical(fn, self, args) {
        var tok = _enterCanonical();
        try { return fn.apply(self, args || []); }
        finally { _exitCanonical(tok); }
    }

    // Canonical text of a tagged input (memo-exact when the field still
    // shows exactly what the units layer wrote, so an untouched default
    // reaches the calc bit-for-bit identical to imperial mode).
    function _canonicalText(el, cat) {
        var shown = String(_nget(el));
        if (_state.system === 'imperial') return shown;
        var memo = el.__wts_memo;
        if (memo && memo.cat === cat && memo.sys === 'imperial' && memo.shown === shown) return String(memo.orig);
        var n = parseFloat(shown);
        if (shown === '' || !isFinite(n)) return shown;
        var c = convertCategory(n, cat, 'metric', 'imperial');
        return (typeof c === 'number' && isFinite(c)) ? String(Number(c.toPrecision(12))) : shown;
    }
    function _accGet() {
        var cat = this.getAttribute && this.getAttribute('data-wts-unit-cat');
        if (!cat || _ctxDepth === 0) return _inDesc.get.call(this);
        return _canonicalText(this, cat);
    }
    function _accSet(v) {
        var cat = this.getAttribute && this.getAttribute('data-wts-unit-cat');
        if (!cat || _ctxDepth === 0 || _state.system === 'imperial') { _inDesc.set.call(this, v); return; }
        // Inside a canonical context an assignment is canonical imperial.
        var s = (v == null) ? '' : String(v), n = parseFloat(s);
        if (s === '' || !isFinite(n)) { _inDesc.set.call(this, v); return; }
        var d = convertCategory(n, cat, 'imperial', 'metric');
        if (typeof d !== 'number' || !isFinite(d)) { _inDesc.set.call(this, v); return; }
        _inDesc.set.call(this, _roundForDisplay(d, cat, 'metric'));
        this.__wts_memo = { cat: cat, sys: 'imperial', orig: s, shown: String(_inDesc.get.call(this)) };
    }
    function _installAccessor(el) {
        if (!_isInputEl(el) || el.__wts_acc) return;
        try {
            Object.defineProperty(el, 'value', { configurable: true, enumerable: true, get: _accGet, set: _accSet });
            el.__wts_acc = true;
        } catch (e) {}
    }

    // Wrap calculator entry points on window so ANY invocation (button,
    // live input/change handler, setTimeout after render, other module)
    // runs inside a canonical context. Re-run on every page change to
    // pick up late-defined functions; idempotent.
    var ENTRY_RE = /^calc[A-Z0-9_]|Export(CSV|PDF)$/;
    function _wrapEntryPoints() {
        if (!_hasWin) return 0;
        var n = 0, keys;
        try { keys = Object.keys(G); } catch (e) { return 0; }
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (!ENTRY_RE.test(k)) continue;
            var f;
            try { f = G[k]; } catch (e) { continue; }
            if (typeof f !== 'function' || f.__wtsCanon) continue;
            (function (orig, name) {
                var w = function () { return runCanonical(orig, this, arguments); };
                w.__wtsCanon = true;
                w.__wtsOrig = orig;
                try { G[name] = w; n++; } catch (e) {}
            })(f, k);
        }
        return n;
    }

    // Events dispatched inside #pgBody run in a canonical context:
    // entered in #pgBody's capture phase (after document-level capture
    // listeners such as the autosave), left in its bubble phase (before
    // document-level bubble listeners); a setTimeout fallback closes it
    // if propagation was stopped below #pgBody.
    var CTX_EVENTS = ['input', 'change', 'click', 'keydown', 'keyup'];
    var _ctxHost = null;
    function _installEventContext() {
        if (!_hasDoc) return;
        var host = _byId('pgBody');
        if (!host || host === _ctxHost || typeof host.addEventListener !== 'function') return;
        _ctxHost = host;
        CTX_EVENTS.forEach(function (type) {
            var stack = [];   // nested dispatches (a handler clicking another node) nest cleanly
            host.addEventListener(type, function () {
                while (stack.length && stack[stack.length - 1].done) stack.pop();
                var tok = _enterCanonical();
                stack.push(tok);
                if (typeof setTimeout === 'function') setTimeout(function () { _exitCanonical(tok); }, 0);
            }, true);
            host.addEventListener(type, function () {
                var tok = stack.pop();
                if (tok) _exitCanonical(tok);
            }, false);
        });
    }

    // ───────────────────────────────────────────────────────────────
    // DOM HELPERS
    // ───────────────────────────────────────────────────────────────
    function _byId(id) {
        if (!_hasDoc) return null;
        try { return document.getElementById(id); } catch (e) { return null; }
    }

    // Find the label element for an input. Strategy:
    //   1. Walk up to nearest `.fg-item` ancestor (the host's
    //      pattern). The first <label> child is the visible label.
    //   2. Fallback: previous-sibling <label>.
    //   3. Fallback: scan parent's children for the first <label>.
    function _findLabelFor(el) {
        if (!el || !el.parentNode) return null;
        var ancestor = el;
        for (var i = 0; i < 4 && ancestor && ancestor.parentNode; i++) {
            ancestor = ancestor.parentNode;
            if (ancestor && ancestor.classList && ancestor.classList.contains &&
                ancestor.classList.contains('fg-item')) {
                if (typeof ancestor.querySelector === 'function') {
                    var lab = ancestor.querySelector('label');
                    if (lab) return lab;
                }
            }
        }
        // Fallback: previous sibling.
        var prev = el.previousElementSibling || (el.previousSibling && el.previousSibling.tagName ? el.previousSibling : null);
        if (prev && prev.tagName === 'LABEL') return prev;
        // Last resort.
        if (el.parentNode && typeof el.parentNode.querySelector === 'function') {
            return el.parentNode.querySelector('label');
        }
        return null;
    }

    // Update a label text to reflect the active unit. Two modes:
    //   - If text contains a parenthesised unit ("Pressure (psig)")
    //     replace the inside of the FIRST () with the new unit.
    //   - Otherwise append " (<unit>)".
    //
    // For dimensionless/empty-unit categories, we do NOTHING (no
    // suffix, no rewrite) so the text stays as the author wrote it.
    var _UNIT_PAREN_RE = /\(([^()]*)\)/;
    function _updateLabelText(labelEl, category) {
        if (!labelEl) return;
        var lbl = _label(category);
        if (!lbl) return; // dimensionless / count / sg etc.
        var current = labelEl.textContent || labelEl.innerText || '';
        // Skip if label already shows the active unit.
        if (current.indexOf('(' + lbl + ')') !== -1) return;
        var next;
        if (_UNIT_PAREN_RE.test(current)) {
            next = current.replace(_UNIT_PAREN_RE, '(' + lbl + ')');
        } else {
            // Append with a single leading space.
            next = current.replace(/\s+$/, '') + ' (' + lbl + ')';
        }
        try {
            labelEl.textContent = next;
        } catch (e) {}
    }

    // ───────────────────────────────────────────────────────────────
    // TAGGING
    //
    // Tagging adds two pieces of metadata to a DOM node:
    //   - data-wts-unit-cat="<category>"            (input fields)
    //   - data-wts-unit-cat-out="<category>"        (output spans)
    //
    // The tag is also used by the Calculate-button wrapper to find
    // every input that needs swapping. Tagging is idempotent.
    // ───────────────────────────────────────────────────────────────
    function tagInput(elementId, category) {
        var el = _byId(elementId);
        if (!el) return false;
        try {
            if (el.dataset) el.dataset.wtsUnitCat = category;
            else if (el.setAttribute) el.setAttribute('data-wts-unit-cat', category);
        } catch (e) {}
        // Update the visible label to match current system.
        var labelEl = _findLabelFor(el);
        if (labelEl) _updateLabelText(labelEl, category);
        // A freshly rendered node holds a canonical (imperial) value —
        // HTML default, loadInputs() or the page-autosave restore — so
        // show it in the active system, once. (__wts_flipped = "this
        // node's text is in the display system"; the host autosave
        // reads it.)
        if (!el.__wts_flipped) {
            el.__wts_flipped = true;
            if (_state.system !== 'imperial' && 'value' in el) _convertInputEl(el, category, 'imperial', _state.system);
            else if (_isInputEl(el)) {
                var t0 = String(_nget(el)), t1 = _tidyText(t0);
                if (t1 !== t0) _nset(el, t1);
            }
        }
        _installAccessor(el);
        return true;
    }

    function tagOutput(elementId, category) {
        var el = _byId(elementId);
        if (!el) return false;
        try {
            if (el.dataset) el.dataset.wtsUnitCatOut = category;
            else if (el.setAttribute) el.setAttribute('data-wts-unit-cat-out', category);
        } catch (e) {}
        return true;
    }

    // Tagged OUTPUTS (data-wts-unit-cat-out): calculators write canonical
    // text; convert it to the display system. Runs whenever a canonical
    // context closes (button, live recalc, timer — same path for all)
    // and on every unit flip (force = re-convert from the stored canonical).
    function _syncTaggedOutputs(force) {
        if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
        var outs;
        try { outs = document.querySelectorAll('[data-wts-unit-cat-out]'); } catch (e) { return; }
        for (var i = 0; i < outs.length; i++) {
            var out = outs[i];
            var cat = out.getAttribute('data-wts-unit-cat-out');
            if (!cat || !CATEGORIES[cat]) continue;
            var isCtl = (out.tagName === 'INPUT' || out.tagName === 'TEXTAREA');
            var text = String(isCtl ? _nget(out) : (out.textContent || ''));
            var st = out.__wts_out;
            var canon;
            if (st && st.shown === text) {
                if (!force) continue;          // still showing what we wrote
                canon = st.canon;
            } else {
                canon = parseFloat(text);      // fresh canonical text from a calc
                if (!isFinite(canon)) continue;
            }
            var shown = text;
            if (_state.system === 'metric') {
                var d = convertCategory(canon, cat, 'imperial', 'metric');
                if (typeof d !== 'number' || !isFinite(d)) continue;
                shown = (Math.abs(d) >= 100) ? d.toFixed(1) : d.toFixed(3);
            } else if (st && st.shown === text) {
                shown = st.canonText;
            }
            try {
                if (shown !== text) { if (isCtl) _nset(out, shown); else out.textContent = shown; }
            } catch (e) {}
            out.__wts_out = { canon: canon, canonText: (st && st.shown === text) ? st.canonText : text, shown: shown };
        }
    }

    // Static unit captions that are not <label>s of a tagged input, e.g.
    // a table header over a column of tagged inputs:
    //   <th data-wts-unit-label="length">Length (ft)</th>
    function _refreshUnitLabels() {
        if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
        var els;
        try { els = document.querySelectorAll('[data-wts-unit-label]'); } catch (e) { return; }
        for (var i = 0; i < els.length; i++) {
            var cat = els[i].getAttribute('data-wts-unit-label');
            if (cat && CATEGORIES[cat]) _updateLabelText(els[i], cat);
        }
    }

    // Route-scoped tagging: ids are only unique per page (ps_t is °F on
    // PRV but °C on Pump Sizing), so tag the manifest of the page on
    // screen. Unknown route -> legacy behaviour (every manifest).
    var _currentRoute = null;
    function _detectRoute() {
        if (!_hasDoc) return null;
        try {
            var b = document.querySelector('.nav-btn.active');
            return (b && b.getAttribute('data-p')) || null;
        } catch (e) { return null; }
    }
    function _applyForCurrentPage() {
        var r = _currentRoute || _detectRoute();
        var n = (r && MANIFEST[r]) ? applyManifest(r) : (r ? 0 : applyAllManifests());
        _refreshUnitLabels();
        _syncTaggedOutputs(false);
        return n;
    }

    function applyManifest(routeName) {
        var entry = MANIFEST[routeName];
        if (!entry) return 0;
        var n = 0;
        if (entry.inputs) {
            var ids = Object.keys(entry.inputs);
            for (var i = 0; i < ids.length; i++) {
                if (tagInput(ids[i], entry.inputs[ids[i]])) n++;
            }
        }
        if (entry.outputs) {
            var oids = Object.keys(entry.outputs);
            for (var j = 0; j < oids.length; j++) {
                if (tagOutput(oids[j], entry.outputs[oids[j]])) n++;
            }
        }
        return n;
    }

    function applyAllManifests() {
        var routes = Object.keys(MANIFEST);
        var total = 0;
        for (var i = 0; i < routes.length; i++) {
            total += applyManifest(routes[i]);
        }
        return total;
    }

    // ───────────────────────────────────────────────────────────────
    // READ / WRITE — the canonical-aware DOM accessors used by code
    // that wants to participate in the toggle without going through
    // the Calculate-button wrapper.
    // ───────────────────────────────────────────────────────────────
    function _categoryFor(elementId) {
        // Live tag first — ids are only unique per page.
        var live = _byId(elementId);
        if (live && live.getAttribute) {
            var lc = live.getAttribute('data-wts-unit-cat') || live.getAttribute('data-wts-unit-cat-out');
            if (lc) return lc;
        }
        var routes = Object.keys(MANIFEST);
        for (var i = 0; i < routes.length; i++) {
            var entry = MANIFEST[routes[i]];
            if (entry.inputs && entry.inputs[elementId]) return entry.inputs[elementId];
            if (entry.outputs && entry.outputs[elementId]) return entry.outputs[elementId];
        }
        // Also check live data-attribute (set by tagInput/tagOutput).
        var el = _byId(elementId);
        if (el && el.dataset) {
            if (el.dataset.wtsUnitCat) return el.dataset.wtsUnitCat;
            if (el.dataset.wtsUnitCatOut) return el.dataset.wtsUnitCatOut;
        }
        return null;
    }

    function readInput(elementId) {
        var el = _byId(elementId);
        if (!el) return NaN;
        var cat = el.getAttribute && el.getAttribute('data-wts-unit-cat');
        // Tagged: the canonical text (memo-exact). Untagged nodes hold
        // canonical values already (fresh render / no conversion).
        var raw = parseFloat(cat ? _canonicalText(el, cat) : _nget(el));
        return isFinite(raw) ? raw : NaN;
    }

    function readInputs(idList) {
        var out = {};
        if (!idList || !idList.length) return out;
        for (var i = 0; i < idList.length; i++) {
            out[idList[i]] = readInput(idList[i]);
        }
        return out;
    }

    function writeOutput(elementId, canonicalValue, category) {
        var el = _byId(elementId);
        if (!el) return false;
        var cat = category || _categoryFor(elementId);
        var v = canonicalValue;
        if (_state.system === 'metric' && cat) {
            v = convertCategory(canonicalValue, cat, 'imperial', 'metric');
        }
        var disp = (typeof v === 'number' && isFinite(v))
            ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3))
            : '';
        try {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') _nset(el, disp);
            else el.textContent = disp;
        } catch (e) {}
        // Remember the canonical so a unit flip re-converts it.
        if (el.getAttribute && el.getAttribute('data-wts-unit-cat-out') && typeof canonicalValue === 'number') {
            el.__wts_out = { canon: canonicalValue, canonText: String(canonicalValue), shown: disp };
        }
        return true;
    }

    function writeOutputs(map) {
        if (!map) return 0;
        var ids = Object.keys(map);
        var n = 0;
        for (var i = 0; i < ids.length; i++) {
            var entry = map[ids[i]];
            if (writeOutput(ids[i], entry.value, entry.category)) n++;
        }
        return n;
    }

    // ───────────────────────────────────────────────────────────────
    // SET-SYSTEM — the master flip. Walks every tagged input on
    // the page, converts its visible value, and rewrites its label.
    // Idempotent: if oldSystem == newSystem, returns immediately.
    // ───────────────────────────────────────────────────────────────
    function setSystem(newSystem) {
        if (newSystem !== 'imperial' && newSystem !== 'metric') {
            _warn('[WTS_units] Invalid system:', newSystem);
            return;
        }
        var oldSystem = _state.system;
        if (oldSystem === newSystem) return;
        _state.system = newSystem;
        _writePersisted(newSystem);

        if (_hasDoc && typeof document.querySelectorAll === 'function') {
            // Walk every tagged input across the page.
            var inputs;
            try {
                inputs = document.querySelectorAll('[data-wts-unit-cat]');
            } catch (e) {
                inputs = [];
            }
            for (var i = 0; i < inputs.length; i++) {
                var el = inputs[i];
                if (!el || !('value' in el)) continue;
                var cat = (el.dataset && el.dataset.wtsUnitCat) ||
                          (el.getAttribute && el.getAttribute('data-wts-unit-cat'));
                if (!cat) continue;
                _convertInputEl(el, cat, oldSystem, newSystem);
                el.__wts_flipped = true;
                // Rewrite label.
                var lab = _findLabelFor(el);
                if (lab) _updateLabelText(lab, cat);
            }
            _refreshUnitLabels();
            _syncTaggedOutputs(true);
        }

        // Update any visible toggle button styling.
        try { _refreshToggleVisuals(); } catch (e) {}

        // Notify any live calculators.
        try {
            if (_hasDoc && typeof document.dispatchEvent === 'function' &&
                typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('wts:unit-system-changed', {
                    detail: { system: newSystem, previous: oldSystem }
                }));
            }
        } catch (e) {}
    }

    // ───────────────────────────────────────────────────────────────
    // (The old capture-phase Calculate-button swap — which rewrote the
    // inputs to canonical only for buttons whose text matched
    // /calculate|compute|run|.../ and so missed every live recalc,
    // setTimeout(calc) after render, and buttons such as "Correct to
    // 60°F" — is replaced by the CANONICAL CONTEXT above.)
    // ───────────────────────────────────────────────────────────────

    // ───────────────────────────────────────────────────────────────
    // AUTO-SAVE CANONICALISER
    //
    // The host auto-saves every edit by writing the DISPLAYED input
    // values to localStorage 'wts_<calcKey>' ('input' debounced 300 ms,
    // 'change' immediately). In metric mode those are metric numbers,
    // but loadInputs() + tagInput()'s fresh flip treat stored values as
    // canonical imperial, so on the next visit a metric value would be
    // converted twice (300 cm saved as "300", reloaded as 300 in, shown
    // as 762 cm). Once the host's write has landed we rewrite every
    // tagged field in that record back to canonical imperial, so the
    // stored values are imperial no matter which system is showing
    // (same as saveInputs() inside a calc, which runs in a canonical
    // context and therefore reads canonical values).
    // ───────────────────────────────────────────────────────────────
    var _canonTimer = null;
    var HOST_LS_PREFIX = 'wts_';

    function _canonicaliseSaved(targetId) {
        if (_state.system !== 'metric' || !targetId) return;
        if (_ctxDepth > 0) {
            if (typeof setTimeout === 'function') setTimeout(function () { _canonicaliseSaved(targetId); }, 50);
            return;
        }
        var target = _byId(targetId);
        if (!target || !('value' in target)) return;
        var ls = null;
        try { ls = (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { ls = null; }
        if (!ls || typeof ls.key !== 'function') return;
        var keys = [];
        try {
            for (var i = 0; i < ls.length; i++) {
                var k = ls.key(i);
                if (k && k.indexOf(HOST_LS_PREFIX) === 0 && k !== STORAGE_KEY) keys.push(k);
            }
        } catch (e) { return; }
        for (var j = 0; j < keys.length; j++) {
            var data;
            try {
                var rawJson = ls.getItem(keys[j]);
                if (!rawJson || rawJson.charAt(0) !== '{') continue;
                data = JSON.parse(rawJson);
            } catch (e) { continue; }
            if (!data || typeof data !== 'object') continue;
            // Only the record the host just wrote holds the edited
            // field's live display text.
            if (data[targetId] === undefined || String(data[targetId]) !== String(target.value)) continue;
            var changed = false;
            var ids = Object.keys(data);
            for (var m = 0; m < ids.length; m++) {
                var el = _byId(ids[m]);
                if (!el || !('value' in el)) continue;
                var cat = (el.dataset && el.dataset.wtsUnitCat) ||
                          (el.getAttribute && el.getAttribute('data-wts-unit-cat'));
                if (!cat) continue;
                // Stored text differs from the display -> already canonical.
                if (String(data[ids[m]]) !== String(el.value)) continue;
                var v = parseFloat(data[ids[m]]);
                if (!isFinite(v)) continue;
                var c = convertCategory(v, cat, 'metric', 'imperial');
                if (typeof c !== 'number' || !isFinite(c)) continue;
                data[ids[m]] = String(Number(c.toPrecision(12)));
                changed = true;
            }
            if (changed) { try { ls.setItem(keys[j], JSON.stringify(data)); } catch (e) {} }
        }
    }

    var _canonInstalled = false;
    function _installAutosaveCanonicaliser() {
        if (_canonInstalled) return;
        if (!_hasDoc || typeof document.addEventListener !== 'function' || typeof setTimeout !== 'function') return;
        try {
            document.addEventListener('input', function (ev) {
                if (_state.system !== 'metric') return;
                var id = ev && ev.target && ev.target.id;
                if (!id) return;
                clearTimeout(_canonTimer);
                // Host debounce is 300 ms — land just after its write.
                _canonTimer = setTimeout(function () { _canonicaliseSaved(id); }, 400);
            }, true);
            document.addEventListener('change', function (ev) {
                if (_state.system !== 'metric') return;
                var id = ev && ev.target && ev.target.id;
                if (!id) return;
                setTimeout(function () { _canonicaliseSaved(id); }, 0);
            }, true);
            _canonInstalled = true;
        } catch (e) {}
    }

    // Installs the canonical-context plumbing: wraps window.calc* /
    // *Export(CSV|PDF) entry points and hooks #pgBody events.
    function _installCalculateWrapper() {
        _wrapEntryPoints();
        _installEventContext();
    }

    // ───────────────────────────────────────────────────────────────
    // UI — header toggle render
    //
    // Renders an inline switch:
    //
    //   Units: [Imperial] [Metric]
    //
    // The active button gets style.background = accent color. Clicking
    // either one calls setSystem('imperial' | 'metric').
    //
    // Idempotent: if the toggle is already in the container, we just
    // re-paint the active state.
    // ───────────────────────────────────────────────────────────────
    var _toggleId = 'wts_unit_toggle';

    function _refreshToggleVisuals() {
        var imp = _byId('wts_units_imperial');
        var met = _byId('wts_units_metric');
        var active = _state.system;
        if (imp && imp.style) {
            imp.style.background = (active === 'imperial') ? 'var(--accent, #f0883e)' : 'transparent';
            imp.style.color      = (active === 'imperial') ? '#0d1117' : 'var(--text2, #8b949e)';
            imp.style.fontWeight = (active === 'imperial') ? '700' : '500';
        }
        if (met && met.style) {
            met.style.background = (active === 'metric') ? 'var(--accent, #f0883e)' : 'transparent';
            met.style.color      = (active === 'metric') ? '#0d1117' : 'var(--text2, #8b949e)';
            met.style.fontWeight = (active === 'metric') ? '700' : '500';
        }
    }

    function renderToggle(container) {
        if (!_hasDoc || !container || typeof container.appendChild !== 'function') return null;
        // If a toggle already exists somewhere on the page (perhaps a
        // hard-coded one in the host HTML), wire up its buttons and
        // bail without creating a duplicate.
        var existing = _byId(_toggleId);
        if (existing) {
            _wireToggleButtons();
            _refreshToggleVisuals();
            return existing;
        }
        var wrap = document.createElement('div');
        wrap.id = _toggleId;
        wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text2,#8b949e);margin-left:12px;';
        wrap.innerHTML =
            '<span>Units:</span>' +
            '<button type="button" id="wts_units_imperial" class="btn btn-secondary" ' +
                'style="padding:3px 8px;font-size:11px;border-radius:4px;border:1px solid var(--border,#30363d);cursor:pointer;background:transparent;color:var(--text2,#8b949e);">Imperial</button>' +
            '<button type="button" id="wts_units_metric" class="btn btn-secondary" ' +
                'style="padding:3px 8px;font-size:11px;border-radius:4px;border:1px solid var(--border,#30363d);cursor:pointer;background:transparent;color:var(--text2,#8b949e);">Metric</button>';
        try { container.appendChild(wrap); } catch (e) { return null; }
        _wireToggleButtons();
        _refreshToggleVisuals();
        return wrap;
    }

    function _wireToggleButtons() {
        var imp = _byId('wts_units_imperial');
        var met = _byId('wts_units_metric');
        if (imp && !imp.__wts_wired) {
            imp.__wts_wired = true;
            imp.onclick = function () { setSystem('imperial'); };
        }
        if (met && !met.__wts_wired) {
            met.__wts_wired = true;
            met.onclick = function () { setSystem('metric'); };
        }
    }

    // Auto-mount: prefer the dedicated host div the page-header
    // markup ships ('wts_unit_toggle_host'); if absent, fall back
    // through several sensible containers.
    function _autoMount() {
        if (!_hasDoc) return;
        // 1. If host pre-rendered an actual toggle, just wire it.
        var existing = _byId(_toggleId);
        if (existing) {
            _wireToggleButtons();
            _refreshToggleVisuals();
            return;
        }
        // 2. Dedicated host container (preferred).
        var host = _byId('wts_unit_toggle_host');
        if (host) { renderToggle(host); return; }
        // 3. Export-buttons row (legacy fallback).
        var ebar = _byId('exportBtns');
        if (ebar) {
            renderToggle(ebar);
            try {
                if (ebar.style && ebar.style.display === 'none') {
                    ebar.style.display = 'flex';
                }
            } catch (e) {}
            return;
        }
        // 4. Page-header div.
        var hdrs;
        try { hdrs = document.querySelectorAll('.page-header'); }
        catch (e) { hdrs = []; }
        if (hdrs && hdrs.length) {
            renderToggle(hdrs[0]);
            return;
        }
        // 5. Last resort: body.
        if (document.body) renderToggle(document.body);
    }

    // After a page render, the host's nav() may toggle exportBtns to
    // display:none on home / clientinfo. Patch that by listening for
    // the host's own pagechange event and re-applying display:flex
    // (only if our toggle is inside it).
    function _patchNavHide() {
        if (!_hasDoc || typeof document.addEventListener !== 'function') return;
        try {
            document.addEventListener('h2oil:pagechange', function (ev) {
                _currentRoute = (ev && ev.detail && ev.detail.page) || _detectRoute();
                var ebar = _byId('exportBtns');
                var tog = _byId(_toggleId);
                if (ebar && tog && ebar.contains && ebar.contains(tog)) {
                    if (ebar.style.display === 'none' || !ebar.style.display) {
                        ebar.style.display = 'flex';
                    }
                }
                // render() has rewritten #pgBody (and the page autosave
                // has restored its values) — tag the fresh inputs of THIS
                // route now, and once more after any deferred rendering.
                _installCalculateWrapper();
                _applyForCurrentPage();
                if (typeof setTimeout === 'function') {
                    setTimeout(function () {
                        _installCalculateWrapper();
                        _applyForCurrentPage();
                    }, 30);
                }
            });
        } catch (e) {}
    }

    // (Fresh-node flipping now happens inside tagInput(), atomically
    // with tagging, so a node is never tagged-but-unflipped.)

    // ───────────────────────────────────────────────────────────────
    // DOM-READY BOOTSTRAP
    //
    // Fires once on script load (or on DOMContentLoaded if not yet
    // ready). Idempotent guards prevent double-mounting.
    // ───────────────────────────────────────────────────────────────
    var _mounted = false;
    function _bootstrap() {
        if (_mounted) return;
        _mounted = true;
        _installCalculateWrapper();
        _installAutosaveCanonicaliser();
        _patchNavHide();
        // Initial mount + tag pass (tagInput flips fresh nodes to the
        // persisted system).
        _autoMount();
        _applyForCurrentPage();
    }

    if (_hasDoc) {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            // Already ready — defer to next tick so any post-script
            // host code has a chance to finish wiring.
            if (typeof setTimeout === 'function') setTimeout(_bootstrap, 0);
            else _bootstrap();
        } else if (typeof document.addEventListener === 'function') {
            document.addEventListener('DOMContentLoaded', _bootstrap);
        }
    }

    // ───────────────────────────────────────────────────────────────
    // PUBLIC EXPORT
    // ───────────────────────────────────────────────────────────────
    var WTS_units = {
        get system() { return _state.system; },
        set system(v) { setSystem(v); },
        getSystem: getSystem,
        setSystem: setSystem,

        convert: convertByUnit,
        convertCategory: convertCategory,

        format: _format,
        label: _label,

        readInput: readInput,
        readInputs: readInputs,
        writeOutput: writeOutput,
        writeOutputs: writeOutputs,

        tagInput: tagInput,
        tagOutput: tagOutput,
        applyManifest: applyManifest,
        applyAllManifests: applyAllManifests,

        renderToggle: renderToggle,

        // Canonical context (see CANONICAL CONTEXT): run fn so that
        // tagged inputs read/write canonical imperial values.
        runCanonical: function (fn, self, args) { return runCanonical(fn, self, args); },
        inCanonicalContext: function () { return _ctxDepth > 0; },
        // The text actually on screen for an input, in any context.
        displayValue: function (el) { return el ? String(_nget(el)) : ''; },

        CATEGORIES: CATEGORIES,
        MANIFEST: MANIFEST,

        // Test-friendly internals (not in the public contract but
        // useful for the self-test below).
        _convertValue: _convertValue,
        _roundForDisplay: _roundForDisplay,
        _convertInputEl: _convertInputEl,
        _canonicalText: _canonicalText,
        _canonicaliseSaved: _canonicaliseSaved,
        _wrapEntryPoints: _wrapEntryPoints,
        _findLabelFor: _findLabelFor,
        _updateLabelText: _updateLabelText,
        _bootstrap: _bootstrap
    };

    G.WTS_units = WTS_units;

    // ════════════════════════════════════════════════════════════════

})();

// ─── END 22-units ─────────────────────────────────────────────

