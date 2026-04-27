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
//   never edited by this layer. Pre-Calculate, we silently swap each
//   tagged input.value to its canonical form, let the original handler
//   run, then restore the displayed metric value and convert any
//   newly-written outputs.
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
        // metric label "Mm3" = 1000 m³, so factor on metric = 1000).
        gasVolume: {
            imperial: { unit: 'MMSCF', label: 'MMSCF', factor: 28316.8, offset: 0 },
            metric:   { unit: 'Mm3',   label: 'Mm³ (10^3 m³)', factor: 1000, offset: 0 }
        },
        gasRate: {
            imperial: { unit: 'MMSCFD', label: 'MMSCFD', factor: 28316.8, offset: 0 },
            metric:   { unit: 'Mm3/d',  label: 'Mm³/d',  factor: 1000,    offset: 0 }
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
        liquidRateSmall: {
            imperial: { unit: 'gal/min', label: 'gpm',   factor: 3.78541, offset: 0 },
            metric:   { unit: 'L/min',   label: 'L/min', factor: 1,       offset: 0 }
        },
        // Mass.
        mass: {
            imperial: { unit: 'lb', label: 'lb', factor: 0.453592, offset: 0 },
            metric:   { unit: 'kg', label: 'kg', factor: 1,        offset: 0 }
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
        gor:      { imperial: { unit: 'scf/stb', label: 'SCF/STB', factor: 1, offset: 0 }, metric: { unit: 'scf/stb', label: 'SCF/STB', factor: 1, offset: 0 } },
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
                a_dP:   'pressureSmall',  // inH2O
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
                c_P1:   'pressure',
                c_P3:   'pressure',
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
        flare: {
            inputs: {
                fl_flow: 'gasRate',
                fl_nhv:  'heatingValue',
                fl_mw:   'dimensionless',
                fl_eff:  'percent',
                fl_H:    'length',
                fl_D:    'length',
                fl_V:    'velocity',
                fl_F:    'dimensionless',
                fl_tau:  'dimensionless',
                fl_W:    'velocity',
                fl_Wd:   'dimensionless',
                fl_Ta:   'temperature',
                fl_cl:   'radiation',
                fl_eta:  'noise',
                fl_ambN: 'noise',
                fl_bgW:  'length',
                fl_bgH:  'length',
                fl_bgOX: 'length',
                fl_bgOY: 'length',
                fl_bgOp: 'percent'
            },
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
                fp_api2: 'api'
            },
            outputs: {}
        },
        tank: {
            inputs: {
                tr_h:    'lengthSmall',
                tr_l:    'lengthSmall',
                tr_w:    'lengthSmall',
                tr_fl:   'lengthSmall',
                tc_d:    'lengthSmall',
                tc_l:    'length',
                tc_fl:   'lengthSmall',
                tk_v1:   'volume',
                tk_v2:   'volume',
                tk_t1:   'time',
                tk_t2:   'time',
                tw_ppg:  'densityLiquid',
                tw_gal:  'volumeSmall',
                tw_tare: 'mass',          // tons treated as mass
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
                el_hp:  'power',
                mp_d:   'lengthSmall',
                mp_sl:  'lengthSmall',
                mp_eff: 'percent',
                mp_spm: 'frequency',
                mp_n:   'count'
            },
            outputs: {}
        },
        chem: {
            inputs: {
                ch_q:   'liquidRate',
                ch_ppm: 'concentration',
                cl_a:   'volumeSmall',  // ml — kept as L/gal proxy; numeric ml stays the same
                cl_b:   'volumeSmall',
                cl_n:   'concentration',
                cl_d:   'volumeSmall'
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
                og_dp:    'pressureSmall',
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
                ps_t:   'temperature', // SI in source HTML — see below
                ps_ps:  'pressureG',
                ps_pd:  'pressureG',
                ps_hs:  'length',
                ps_hd:  'length',
                ps_ls:  'length',
                ps_ld:  'length',
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
                // sh_t is in °C in the source HTML — already SI.
                // Tag as temperature so the toggle re-paints labels,
                // but its imperial display (when enabled) becomes °F.
                sh_t:      'temperature',
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
                ih_ti:  'temperature', // °C in source — tag for label switch
                ih_to:  'temperature',
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
                fa_t:  'temperature',
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
                tm_t:    'temperature', // °C in source
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
                cs_pf:  'powerFactor',
                cs_l:   'length',  // labelled "(m)" in source — already SI.
                cs_amb: 'temperature' // °C
            },
            outputs: {}
        },
        vdrop: {
            inputs: {
                vd_v:  'voltage',
                vd_i:  'current',
                vd_pf: 'powerFactor',
                vd_l:  'length'  // (m)
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
        var raw = parseFloat(el.value);
        if (!isFinite(raw)) return NaN;
        if (_state.system === 'imperial') return raw;
        var cat = _categoryFor(elementId);
        if (!cat) return raw;
        return convertCategory(raw, cat, 'metric', 'imperial');
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
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = disp;
            else el.textContent = disp;
        } catch (e) {}
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
                var raw = parseFloat(el.value);
                if (isFinite(raw)) {
                    var converted = convertCategory(raw, cat, oldSystem, newSystem);
                    if (typeof converted === 'number' && isFinite(converted)) {
                        var rounded = (Math.abs(converted) >= 100)
                            ? Number(converted.toFixed(1))
                            : Number(converted.toFixed(4));
                        try { el.value = rounded; } catch (e) {}
                    }
                }
                // Rewrite label.
                var lab = _findLabelFor(el);
                if (lab) _updateLabelText(lab, cat);
            }
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
    // CALCULATE-BUTTON WRAPPER
    //
    // Capture-phase document click listener. Whenever a button whose
    // text contains "Calculate" / "Compute" / "Run" / etc. is clicked
    // AND the system is 'metric', we:
    //
    //   1. Walk the panel's tagged inputs.
    //   2. Read each displayed metric value.
    //   3. Convert metric -> imperial (canonical).
    //   4. Set input.value to the canonical value (so the original
    //      handler reads imperial, exactly as the calculator expects).
    //   5. Schedule a setTimeout(0) microtask to:
    //         a. Restore each input.value to its metric display.
    //         b. Walk tagged outputs and convert their canonical
    //            text content to metric.
    //
    // In imperial mode, this listener is a no-op (early return).
    // ───────────────────────────────────────────────────────────────
    var CALC_BUTTON_RE = /\b(calculate|compute|run|generate|build|simulate|analyse|analyze|estimate|size\b)/i;

    function _findPanel(btn) {
        if (!btn) return null;
        var node = btn;
        for (var i = 0; i < 12 && node; i++) {
            // Heuristic: stop at the page body (id="pgBody") or a
            // .module / .panel / .calc / .card-grid container.
            if (node.id === 'pgBody') return node;
            if (node.classList && node.classList.contains) {
                if (node.classList.contains('module') ||
                    node.classList.contains('panel') ||
                    node.classList.contains('calc') ||
                    node.classList.contains('cols-2')) {
                    // Walk up one more level to capture sibling cards.
                    return node.parentNode || node;
                }
            }
            node = node.parentNode;
        }
        return _hasDoc && document.body ? document.body : null;
    }

    function _onClickCapture(ev) {
        try {
            if (_state.system === 'imperial') return;
            var btn = ev && ev.target;
            if (!btn || !btn.tagName) return;
            // Walk up one level if the click landed on a child of the
            // button (e.g. an icon span).
            if (btn.tagName !== 'BUTTON') {
                var p = btn.parentNode;
                if (p && p.tagName === 'BUTTON') btn = p;
                else return;
            }
            var text = (btn.textContent || '').trim();
            if (!CALC_BUTTON_RE.test(text)) return;

            var panel = _findPanel(btn);
            if (!panel || typeof panel.querySelectorAll !== 'function') return;

            var taggedInputs;
            try { taggedInputs = panel.querySelectorAll('[data-wts-unit-cat]'); }
            catch (e) { taggedInputs = []; }

            var rollback = [];
            for (var i = 0; i < taggedInputs.length; i++) {
                var inp = taggedInputs[i];
                if (!inp || !('value' in inp)) continue;
                var cat = (inp.dataset && inp.dataset.wtsUnitCat) ||
                          (inp.getAttribute && inp.getAttribute('data-wts-unit-cat'));
                if (!cat) continue;
                var displayVal = parseFloat(inp.value);
                if (!isFinite(displayVal)) continue;
                var canonicalVal = convertCategory(displayVal, cat, 'metric', 'imperial');
                if (typeof canonicalVal !== 'number' || !isFinite(canonicalVal)) continue;
                rollback.push({ inp: inp, displayVal: inp.value });
                try { inp.value = canonicalVal; } catch (e) {}
            }

            // Restore display values + post-convert outputs.
            var restore = function () {
                for (var k = 0; k < rollback.length; k++) {
                    try { rollback[k].inp.value = rollback[k].displayVal; } catch (e) {}
                }
                if (panel && typeof panel.querySelectorAll === 'function') {
                    var outs;
                    try { outs = panel.querySelectorAll('[data-wts-unit-cat-out]'); }
                    catch (e) { outs = []; }
                    for (var m = 0; m < outs.length; m++) {
                        var out = outs[m];
                        var ocat = (out.dataset && out.dataset.wtsUnitCatOut) ||
                                   (out.getAttribute && out.getAttribute('data-wts-unit-cat-out'));
                        if (!ocat) continue;
                        var raw = (out.tagName === 'INPUT' || out.tagName === 'TEXTAREA')
                            ? parseFloat(out.value)
                            : parseFloat(out.textContent || '');
                        if (!isFinite(raw)) continue;
                        var dispVal = convertCategory(raw, ocat, 'imperial', 'metric');
                        if (typeof dispVal !== 'number' || !isFinite(dispVal)) continue;
                        var rounded = (Math.abs(dispVal) >= 100)
                            ? dispVal.toFixed(1)
                            : dispVal.toFixed(3);
                        try {
                            if (out.tagName === 'INPUT' || out.tagName === 'TEXTAREA') out.value = rounded;
                            else out.textContent = rounded;
                        } catch (e) {}
                    }
                }
            };
            // Use setTimeout(0) so we run AFTER the original click
            // handler completes (synchronous handler will have read
            // the canonical values we just stuffed in).
            if (typeof setTimeout === 'function') setTimeout(restore, 0);
        } catch (e) {
            _err('[WTS_units] Calculate-wrapper crashed:', e && e.message);
        }
    }

    var _wrapperInstalled = false;
    function _installCalculateWrapper() {
        if (_wrapperInstalled) return;
        if (!_hasDoc || typeof document.addEventListener !== 'function') return;
        try {
            document.addEventListener('click', _onClickCapture, true);
            _wrapperInstalled = true;
        } catch (e) {}
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
            document.addEventListener('h2oil:pagechange', function () {
                var ebar = _byId('exportBtns');
                if (!ebar) return;
                var tog = _byId(_toggleId);
                if (tog && ebar.contains && ebar.contains(tog)) {
                    if (ebar.style.display === 'none' || !ebar.style.display) {
                        ebar.style.display = 'flex';
                    }
                }
                // Also re-apply any manifest tags for the new route.
                // The host calls render() which rewrites pgBody, so
                // input IDs are fresh — re-tag them.
                if (typeof setTimeout === 'function') {
                    setTimeout(function () {
                        applyAllManifests();
                        // If we're in metric mode, also flip every
                        // newly-rendered input from its imperial
                        // default to the metric display.
                        if (_state.system === 'metric') {
                            _flipFreshInputs('imperial', 'metric');
                        }
                    }, 30);
                }
            });
        } catch (e) {}
    }

    // Helper used right after a re-render: flips every tagged input's
    // default value from imperial -> metric (or vice versa). Distinct
    // from setSystem because the system flag has NOT changed.
    function _flipFreshInputs(fromSys, toSys) {
        if (!_hasDoc || typeof document.querySelectorAll !== 'function') return;
        var inputs;
        try { inputs = document.querySelectorAll('[data-wts-unit-cat]'); }
        catch (e) { return; }
        for (var i = 0; i < inputs.length; i++) {
            var el = inputs[i];
            if (!el || !('value' in el)) continue;
            // Skip fresh inputs that have already been flipped
            // (marker on the DOM node, cleared on each tagInput call).
            if (el.__wts_flipped) continue;
            el.__wts_flipped = true;
            var cat = (el.dataset && el.dataset.wtsUnitCat) ||
                      (el.getAttribute && el.getAttribute('data-wts-unit-cat'));
            if (!cat) continue;
            var raw = parseFloat(el.value);
            if (!isFinite(raw)) continue;
            var converted = convertCategory(raw, cat, fromSys, toSys);
            if (typeof converted !== 'number' || !isFinite(converted)) continue;
            var rounded = (Math.abs(converted) >= 100)
                ? Number(converted.toFixed(1))
                : Number(converted.toFixed(4));
            try { el.value = rounded; } catch (e) {}
        }
    }

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
        _patchNavHide();
        // Initial mount + tag pass.
        _autoMount();
        applyAllManifests();
        // If persisted state is metric, flip the inputs that just got
        // tagged (they hold imperial defaults from the host HTML).
        if (_state.system === 'metric') {
            _flipFreshInputs('imperial', 'metric');
        }
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

        CATEGORIES: CATEGORIES,
        MANIFEST: MANIFEST,

        // Test-friendly internals (not in the public contract but
        // useful for the self-test below).
        _convertValue: _convertValue,
        _findLabelFor: _findLabelFor,
        _updateLabelText: _updateLabelText,
        _onClickCapture: _onClickCapture,
        _bootstrap: _bootstrap
    };

    G.WTS_units = WTS_units;

    // ════════════════════════════════════════════════════════════════
    // === SELF-TEST ===
    // ════════════════════════════════════════════════════════════════
    (function () {
        var checks = [];
        var EPS = 1e-3;
        function near(a, b, e) { return Math.abs(a - b) <= (e == null ? EPS : e); }
        function check(name, ok, info) { checks.push({ name: name, ok: !!ok, info: info }); }

        // Pure conversion sanity.
        check('100 psi -> 689.476 kPa',
            near(convertCategory(100, 'pressure', 'imperial', 'metric'), 689.476, 0.01));
        check('50 psig -> 344.74 kPa(g)',
            near(convertCategory(50, 'pressureG', 'imperial', 'metric'), 344.738, 0.01));
        check('212 F -> 100 C',
            near(convertCategory(212, 'temperature', 'imperial', 'metric'), 100, 0.01));
        check('0 F -> -17.778 C',
            near(convertCategory(0, 'temperature', 'imperial', 'metric'), -17.778, 0.01));
        check('100 C -> 212 F (round-trip)',
            near(convertCategory(100, 'temperature', 'metric', 'imperial'), 212, 0.01));
        check('R -> K (519.67 R -> 288.706 K)',
            near(convertCategory(519.67, 'tempAbsolute', 'imperial', 'metric'), 288.706, 0.01));
        check('1 ft -> 0.3048 m',
            near(convertCategory(1, 'length', 'imperial', 'metric'), 0.3048, 1e-6));
        check('1 in -> 25.4 mm',
            near(convertCategory(1, 'lengthSmall', 'imperial', 'metric'), 25.4, 1e-6));
        check('100 ft2 -> 9.2903 m2',
            near(convertCategory(100, 'area', 'imperial', 'metric'), 9.2903, 1e-3));
        check('1 bbl -> 0.158987 m3',
            near(convertCategory(1, 'volume', 'imperial', 'metric'), 0.158987, 1e-6));
        check('1 gal -> 3.78541 L',
            near(convertCategory(1, 'volumeSmall', 'imperial', 'metric'), 3.78541, 1e-5));
        check('10 MMSCFD -> 283.168 Mm3/d',
            near(convertCategory(10, 'gasRate', 'imperial', 'metric'), 283.168, 1e-2));
        check('1000 BPD -> 158.987 m3/d',
            near(convertCategory(1000, 'liquidRate', 'imperial', 'metric'), 158.987, 1e-2));
        check('1 lb -> 0.453592 kg',
            near(convertCategory(1, 'mass', 'imperial', 'metric'), 0.453592, 1e-6));
        check('62.4 lb/ft3 -> 999.555 kg/m3',
            near(convertCategory(62.4, 'density', 'imperial', 'metric'), 999.5544, 1e-2));
        check('5 cP -> 5 mPa.s (1:1)',
            near(convertCategory(5, 'viscosity', 'imperial', 'metric'), 5, 1e-9));
        check('100 ft/s -> 30.48 m/s',
            near(convertCategory(100, 'velocity', 'imperial', 'metric'), 30.48, 1e-3));
        check('1 md -> 1 mD',
            near(convertCategory(1, 'permeability', 'imperial', 'metric'), 1, 1e-9));
        check('100 md.ft -> 30.48 mD.m',
            near(convertCategory(100, 'permThickness', 'imperial', 'metric'), 30.48, 1e-3));
        check('1e-5 1/psi -> 1.4504e-6 1/kPa',
            near(convertCategory(1e-5, 'compressibility', 'imperial', 'metric'), 1e-5/6.89476, 1e-9));
        check('100 hp -> 74.57 kW',
            near(convertCategory(100, 'power', 'imperial', 'metric'), 74.57, 1e-3));
        check('1000 Btu -> 1055.06 kJ',
            near(convertCategory(1000, 'energy', 'imperial', 'metric'), 1055.06, 1e-2));
        check('100 lbf -> 444.822 N',
            near(convertCategory(100, 'force', 'imperial', 'metric'), 444.822, 1e-3));
        check('100 lbf.ft -> 135.582 N.m',
            near(convertCategory(100, 'torque', 'imperial', 'metric'), 135.582, 1e-3));
        check('1.58 BTU/hr/ft2 -> 0.00498 kW/m2',
            near(convertCategory(1.58, 'radiation', 'imperial', 'metric'), 1.58 * 0.003154, 1e-6));
        check('100 BTU/hr/F -> 52.75 W/K',
            near(convertCategory(100, 'heatTransfer', 'imperial', 'metric'), 52.75, 1e-2));

        // Round-trip / identity.
        check('round-trip pressure',
            near(convertCategory(convertCategory(123.456, 'pressure', 'imperial', 'metric'),
                                  'pressure', 'metric', 'imperial'), 123.456, 1e-6));
        check('round-trip temperature',
            near(convertCategory(convertCategory(180, 'temperature', 'imperial', 'metric'),
                                  'temperature', 'metric', 'imperial'), 180, 1e-6));
        check('round-trip gasRate',
            near(convertCategory(convertCategory(10, 'gasRate', 'imperial', 'metric'),
                                  'gasRate', 'metric', 'imperial'), 10, 1e-6));
        check('round-trip volumeSmall',
            near(convertCategory(convertCategory(2.5, 'volumeSmall', 'imperial', 'metric'),
                                  'volumeSmall', 'metric', 'imperial'), 2.5, 1e-6));
        check('imperial -> imperial is identity',
            convertCategory(42, 'pressure', 'imperial', 'imperial') === 42);
        check('metric -> metric is identity',
            convertCategory(42, 'pressure', 'metric', 'metric') === 42);
        check('unknown category falls through',
            convertCategory(7, 'definitely_not_a_category', 'imperial', 'metric') === 7);
        check('NaN input -> NaN out',
            isNaN(convertCategory(NaN, 'pressure', 'imperial', 'metric')));

        // Format / label.
        var f = _format(100, 'pressure');
        check('format(100 psi) (imperial system)',
            f.unit === 'psi' && f.value === 100 && f.label === 'psi');
        check('label(temperature) returns °F in imperial',
            _label('temperature') === '°F');

        // CATEGORIES coverage.
        var requiredCats = [
            'pressure','pressureG','temperature','tempAbsolute','length','lengthSmall',
            'area','volume','volumeSmall','gasVolume','gasRate','liquidRate','liquidRateSmall',
            'mass','massRate','density','viscosity','velocity','permeability','permThickness',
            'compressibility','power','energy','voltage','current','frequency','force','torque',
            'concentration','percent','sg','api','dimensionless','count','noise','radiation',
            'heatTransfer'
        ];
        var missingCats = [];
        for (var c = 0; c < requiredCats.length; c++) {
            if (!CATEGORIES[requiredCats[c]]) missingCats.push(requiredCats[c]);
        }
        check('all required categories defined (' + requiredCats.length + ')',
            missingCats.length === 0,
            missingCats.length ? 'missing: ' + missingCats.join(', ') : null);

        // MANIFEST sanity.
        var routeKeys = Object.keys(MANIFEST);
        check('manifest has >= 10 routes', routeKeys.length >= 10,
            'routes=' + routeKeys.length);
        var totalInputIds = 0;
        var unknownCats = [];
        for (var rk = 0; rk < routeKeys.length; rk++) {
            var entry = MANIFEST[routeKeys[rk]];
            if (entry.inputs) {
                var ids = Object.keys(entry.inputs);
                totalInputIds += ids.length;
                for (var ii = 0; ii < ids.length; ii++) {
                    var ec = entry.inputs[ids[ii]];
                    if (!CATEGORIES[ec]) unknownCats.push(routeKeys[rk] + '.' + ids[ii] + '=' + ec);
                }
            }
        }
        check('manifest has >= 100 input IDs', totalInputIds >= 100,
            'count=' + totalInputIds);
        check('every manifest category exists in CATEGORIES',
            unknownCats.length === 0,
            unknownCats.length ? unknownCats.slice(0, 5).join('; ') : null);

        // Idempotent setSystem.
        var initialSystem = _state.system;
        try {
            setSystem(initialSystem); // no-op
            setSystem(initialSystem); // no-op
            check('setSystem(same) is idempotent', _state.system === initialSystem);
        } catch (e) {
            check('setSystem(same) is idempotent', false, e && e.message);
        }

        // tagInput returns false for missing element (defensive).
        var taggedMissing = tagInput('this_element_does_not_exist_xyz_12345', 'pressure');
        check('tagInput returns false for missing element', taggedMissing === false);

        // applyManifest returns 0 for unknown route.
        check('applyManifest returns 0 for unknown route',
            applyManifest('definitely_not_a_route') === 0);

        // Public API surface.
        check('window.WTS_units present', G && typeof G.WTS_units === 'object');
        check('WTS_units.setSystem is fn', typeof WTS_units.setSystem === 'function');
        check('WTS_units.convert is fn', typeof WTS_units.convert === 'function');
        check('WTS_units.convertCategory is fn', typeof WTS_units.convertCategory === 'function');
        check('WTS_units.format is fn', typeof WTS_units.format === 'function');
        check('WTS_units.label is fn', typeof WTS_units.label === 'function');
        check('WTS_units.readInput is fn', typeof WTS_units.readInput === 'function');
        check('WTS_units.writeOutput is fn', typeof WTS_units.writeOutput === 'function');
        check('WTS_units.tagInput is fn', typeof WTS_units.tagInput === 'function');
        check('WTS_units.applyManifest is fn', typeof WTS_units.applyManifest === 'function');
        check('WTS_units.applyAllManifests is fn', typeof WTS_units.applyAllManifests === 'function');
        check('WTS_units.renderToggle is fn', typeof WTS_units.renderToggle === 'function');
        check('WTS_units.CATEGORIES is obj', typeof WTS_units.CATEGORIES === 'object');
        check('WTS_units.MANIFEST is obj', typeof WTS_units.MANIFEST === 'object');

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            _err('WTS_units self-test FAILED:', fails.map(function (f) {
                return f.name + (f.info ? ' [' + f.info + ']' : '');
            }));
        } else {
            _log('✓ WTS_units self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
