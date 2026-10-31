// Chemical Injection (v3.2a) — foundation tests:
//   • prism-build/40-calc-chemlib.js — window.WTS_chemlib data module (no page):
//     shape and internal consistency, the plan's suitability matrix (§3.3),
//     scavenger stoichiometry and η defaults (§3.4, §5.1), pump presets and
//     their pressure envelopes (§4.10, §5.2), capillary lines (§5.3),
//     compatibility and elastomer tables (§5.4, §5.5), decided defaults;
//   • prism-build/46-calc-gaspvt.js — the additive exports WTS_gaspvt_z,
//     WTS_gaspvt_enthalpy and WTS_gaspvt_isenthalpic: plan tests N7 (solver),
//     V1 (methane μJT against the NIST reference) and V2 (Katz permissible
//     expansion chart), plus memo / stats, clamps and mol % inputs.
//
// Expected values are written out from docs/CHEMICAL-INJECTION-PLAN.md and
// independent hand formulas (geometry, Barlow, stoichiometry), not from the
// module's own code.
'use strict';

const WP = 'CHEM';

// App values live in another realm (their Array/Object prototypes differ from the test's),
// so deep comparisons go through JSON first.
const J = (x) => JSON.parse(JSON.stringify(x));
function eq(assert, actual, expected, msg) { assert.deepStrictEqual(J(actual), J(expected), msg); }

const POINTS =['dh', 'wh', 'dsch', 'sepin', 'sepgas', 'flare', 'sepoil', 'sepwat', 'tank'];
// Plan §3.3, one letter per point in POINTS order (dh wh dsch sepin sepgas flare sepoil sepwat tank).
const MATRIX = {
  thi_alcohol: 'ARANANXXX',
  thi_glycol: 'ARANNXXXX',
  ldhi_khi: 'ARANXXXXX',
  ldhi_aa: 'ARANXXXXX',
  scav_aqueous: 'NRAANXNNN',      // the plan's "sepoil N (MMA: A)" and "sepwat A (glyoxal)" are chemical overrides
  scav_oil: 'XANNXXRXA',
  scav_oxidiser: 'XXXXXXXRN',
  ci_oil: 'RAAANXNNN',
  ci_aqueous: 'RAAAXXXAN',
  ci_gaswell: 'ARANNXXXX',
  scale: 'RAAAXXXAN',
  antifoam: 'XNARXXNXA',
  emulsion: 'ARAAXXAXA',
  clarifier: 'XNNAXXXRA',
  wax: 'RAANXXAXA',
  pour_point: 'NAANXXRXA',
  asphaltene: 'RANNXXNXN',
  water_systems: 'XXXXXXXAA',
  custom: 'AAAAAAAAA',
};
// Plan §5.1 family of every chemical.
const FAMILY_OF = {
  meoh: 'thi_alcohol', etoh: 'thi_alcohol', meg: 'thi_glycol', deg: 'thi_glycol', teg: 'thi_glycol',
  khi: 'ldhi_khi', aa: 'ldhi_aa',
  h2s_mea_triazine: 'scav_aqueous', h2s_mma_triazine: 'scav_aqueous', h2s_glyoxal: 'scav_aqueous', h2s_aldehyde_blend: 'scav_aqueous',
  h2s_oil_soluble: 'scav_oil', h2s_zinc: 'scav_oil', h2s_nitrite: 'scav_oxidiser', h2s_peroxide: 'scav_oxidiser',
  ci_film_liq: 'ci_oil', ci_water: 'ci_aqueous', ci_gas: 'ci_gaswell', si_phosphonate: 'scale', si_polymer: 'scale',
  af_silicone: 'antifoam', af_nonsilicone: 'antifoam', demulsifier: 'emulsion', water_clarifier: 'clarifier',
  paraffin_inhibitor: 'wax', ppd: 'pour_point', asphaltene_inhibitor: 'asphaltene', biocide: 'water_systems',
  o2_scavenger: 'water_systems', custom: 'custom',
};
// Plan §5.1 [basis, default dose, min, max, SG, water fraction]
const CHEM_DATA = {
  meoh: ['wt_water', null, null, null, 0.796, 0], etoh: ['wt_water', null, null, null, 0.794, 0],
  meg: ['wt_water', null, null, null, 1.116, 0], deg: ['wt_water', null, null, null, 1.118, 0], teg: ['wt_water', null, null, null, 1.125, 0],
  khi: ['vol_water', 1.5, 0.5, 3, 1.00, 0.30], aa: ['vol_water', 2.0, 0.5, 3, 0.95, 0.10],
  h2s_mea_triazine: ['gal_lb_h2s', null, 0.9, 2.2, 1.11, 0.60], h2s_mma_triazine: ['gal_lb_h2s', null, 0.6, 1.6, 1.03, 0.60],
  h2s_glyoxal: ['gal_lb_h2s', null, 0.5, 2.5, 1.27, 0.60], h2s_aldehyde_blend: ['gal_lb_h2s', 1.2, 0.6, 2.0, 1.10, 0.50],
  h2s_oil_soluble: ['ppm_per_ppm_liq', 8, 3, 20, 0.95, 0], h2s_zinc: ['gal_lb_h2s', 1.9, 1.6, 3.0, 1.00, 0],
  h2s_nitrite: ['gal_lb_h2s', 0.4, 0.25, 0.8, 1.20, 0.70], h2s_peroxide: ['gal_lb_h2s', 0.4, 0.3, 1.4, 1.13, 0.65],
  ci_film_liq: ['ppmv_liq', 25, 10, 100, 0.92, 0], ci_water: ['ppmv_water', 50, 20, 200, 1.03, 0.60], ci_gas: ['pt_mmscf', 1.0, 0.25, 2, 0.92, 0],
  si_phosphonate: ['ppmw_water', 10, 2, 50, 1.20, 0.60], si_polymer: ['ppmw_water', 15, 5, 50, 1.15, 0.60],
  af_silicone: ['ppmv_oil', 5, 1, 30, 0.95, 0], af_nonsilicone: ['ppmv_oil', 20, 5, 100, 0.98, 0],
  demulsifier: ['ppmv_oil', 30, 5, 200, 0.94, 0], water_clarifier: ['ppmv_water', 10, 2, 50, 1.05, 0.60],
  paraffin_inhibitor: ['ppmv_oil', 200, 50, 1000, 0.90, 0], ppd: ['ppmv_oil', 300, 100, 2000, 0.90, 0],
  asphaltene_inhibitor: ['ppmv_oil', 200, 50, 1000, 0.92, 0], biocide: ['ppmv_water', 250, 50, 1000, 1.10, 0.50],
  o2_scavenger: ['ppm_per_ppm_o2', 10, 8, 15, 1.35, 0.35],
};

// Methane μJT (K/MPa), NIST Chemistry WebBook (Setzmann–Wagner 1991), plan §4.1.3.
const NIST = [[300, 0.1, 4.322], [300, 2.1, 4.197], [300, 5.1, 3.932], [300, 10.1, 3.244],
  [250, 0.1, 6.192], [250, 2.1, 6.124], [250, 5.1, 5.783], [250, 10.1, 4.130]];
const PSI_PER_MPA = 145.0377377;

module.exports = [
  {
    name: 'CHEM chemlib shape: 30 generic chemicals, 19 families, 9 points in flow order, 8 pumps, lookups; data only (no page)',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib;
      assert.ok(C && typeof C === 'object', 'window.WTS_chemlib');
      assert.strictEqual(C.chemicals.length, 30, 'chemicals');
      assert.strictEqual(C.families.length, 19, 'families');
      assert.strictEqual(C.pumps.length, 8, 'pumps');
      eq(assert, Array.from(C.points.map((p) => p.key)), POINTS, 'points in flow order');
      eq(assert, Array.from(C.pointKeys), POINTS, 'pointKeys');
      ['find', 'list', 'family', 'point', 'pump', 'cap', 'suit', 'suitInfo', 'eff', 'pairRules', 'ctxRules', 'elastomerRow']
        .forEach((f) => assert.fn(C[f], f));
      // Data module: no registry entry, no sidebar button, no tile.
      assert.ok(!(app.win.WTS_calcRegistry || {}).chemlib, 'no WTS_calcRegistry.chemlib');
      assert.ok(!app.find('.nav-btn[data-p="chemlib"]'), 'no sidebar button');
      // Keys unique, lookups return the same record.
      const keys = C.chemicals.map((c) => c.key);
      assert.strictEqual(new Set(keys).size, keys.length, 'unique chemical keys');
      eq(assert, keys.slice().sort(), Object.keys(FAMILY_OF).sort(), 'the plan §5.1 key list');
      C.chemicals.forEach((c) => assert.strictEqual(C.find(c.key), c, 'find ' + c.key));
      C.pumps.forEach((p) => assert.strictEqual(C.pump(p.key), p, 'pump ' + p.key));
      C.points.forEach((p) => assert.strictEqual(C.point(p.key), p, 'point ' + p.key));
      assert.strictEqual(C.find('nope'), null, 'unknown chemical');
      assert.strictEqual(C.suit('meoh', 'nowhere'), null, 'unknown point');
      assert.strictEqual(C.list().length, 30, 'list()');
      eq(assert, C.list('hydrate').map((c) => c.key), ['meoh', 'etoh', 'meg', 'deg', 'teg', 'khi', 'aa'], 'list(group)');
      eq(assert, C.list('thi_glycol').map((c) => c.key), ['meg', 'deg', 'teg'], 'list(family)');
      assert.strictEqual(C.chemicals[C.chemicals.length - 1].key, 'custom', 'custom last');
      // Groups cover every family; every chemical's group/kind follow its family.
      const groupKeys = C.groups.map((g) => g.key);
      C.families.forEach((f) => assert.ok(groupKeys.indexOf(f.group) !== -1, f.key + ' group'));
      C.chemicals.forEach((c) => {
        const f = C.family(c.family);
        assert.ok(f, c.key + ' family');
        assert.strictEqual(c.family, FAMILY_OF[c.key], c.key + ' family per plan');
        assert.strictEqual(c.group, f.group, c.key + ' group');
        assert.strictEqual(c.kind, f.kind, c.key + ' kind');
      });
    },
  },
  {
    name: 'CHEM chemlib chemicals: plan §5.1 bases, doses, SG and water; ranges, physical fields, flags and plain-text cautions',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib;
      Object.keys(CHEM_DATA).forEach((k) => {
        const c = C.find(k), d = CHEM_DATA[k];
        assert.strictEqual(c.basis, d[0], k + ' basis');
        assert.strictEqual(c.dose, d[1], k + ' dose');
        assert.strictEqual(c.doseMin, d[2], k + ' dose min');
        assert.strictEqual(c.doseMax, d[3], k + ' dose max');
        assert.strictEqual(c.sg, d[4], k + ' SG');
        assert.strictEqual(c.water, d[5], k + ' water fraction');
      });
      C.chemicals.forEach((c) => {
        const k = c.key;
        assert.ok(C.bases[c.basis] && C.bases[c.basis].key === c.basis, k + ' basis exists');
        if (c.dose != null) assert.within(c.dose, c.doseMin, c.doseMax, k + ' default dose inside its range');
        assert.ok(c.water >= 0 && c.water < 1, k + ' water is a fraction');
        assert.strictEqual(c.aqueous, c.water > 0, k + ' aqueous flag');
        assert.ok(c.mu68 > 0 && c.muB > 0, k + ' viscosity');
        assert.ok(app.win.WTS_chemlib.fluidClasses[c.fluidClass], k + ' fluid class');
        assert.rel(c.dPdT, c.alphaV / c.beta, 1e-12, k + ' dP/dT = α/β');
        assert.ok(c.peak >= 1 && c.peak <= 3, k + ' peak factor');
        ['flammable', 'oxidiser', 'vapourLoss', 'aqueous'].forEach((f) => assert.strictEqual(typeof c[f], 'boolean', k + ' ' + f));
        assert.ok(['H', 'M', 'L', 'L–M', 'M–L'].indexOf(c.conf) !== -1, k + ' confidence tag ' + c.conf);
        assert.ok(typeof c.cautions === 'string' && c.cautions.length > 0 && c.cautions.length < 299, k + ' cautions < 299 characters');
        // Temperatures live in numeric fields (flashF, freezeF, bestTempF) so the page can show them in Metric.
        assert.ok(!/°[FC]/.test(c.cautions + c.name + c.short), k + ': no temperature unit in the text');
        assert.ok(!/[<>&]/.test(c.cautions + c.name + c.short), k + ': plain text');
        assert.ok(Array.isArray(c.incompat), k + ' incompat tags');
      });
      // Hazard flags the plan names.
      assert.ok(C.find('meoh').vapourLoss && C.find('meoh').flammable && C.find('etoh').vapourLoss, 'alcohol flags');
      assert.ok(C.find('h2s_nitrite').oxidiser && C.find('h2s_peroxide').oxidiser, 'oxidisers');
      assert.strictEqual(C.chemicals.filter((c) => c.oxidiser).length, 2, 'only nitrite and peroxide are oxidisers');
      assert.strictEqual(C.find('meoh').flashF, 52, 'methanol flash point 52 °F');
      assert.strictEqual(C.find('meg').freezeF, 9, 'pure MEG freezes at 9 °F');
      // Blocked-in pressure rise (§4.11.1): methanol 77, water-based ≈ 38, MEG ≈ 140, solvent ≈ 80 psi/°F.
      assert.near(C.find('meoh').dPdT, 77, 0.5, 'methanol');
      assert.near(C.find('h2s_mea_triazine').dPdT, 38, 0.5, 'water-based');
      assert.near(C.find('meg').dPdT, 140, 1, 'MEG');
      assert.near(C.find('demulsifier').dPdT, 80, 1, 'solvent');
      assert.strictEqual(C.find('meoh').beta, 8.6e-6, 'methanol β (§4.10.2)');
      // Density: methanol 0.796 × 8.337 = 6.636 lb/gal (H1).
      assert.near(C.find('meoh').sg * C.constants.lbPerGalWater, 6.636, 0.001, 'methanol lb/gal');
      // Every non-THI ppm or volume basis stays a number; THI and stoichiometric scavengers are computed.
      C.chemicals.forEach((c) => {
        if (c.kind === 'thi' || (c.kind === 'scavenger' && c.stoich) || c.key === 'custom') assert.strictEqual(c.dose, null, c.key + ' computed dose');
        else assert.finite(c.dose, c.key + ' preset dose');
      });
    },
  },
  {
    name: 'CHEM chemlib thermodynamic inhibitors: 25-hydrate key map (ethanol local), lean ranges, freeze curves (H1 rich phase ≈ −33.7 °F)',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib;
      const thi = C.chemicals.filter((c) => c.kind === 'thi');
      eq(assert, thi.map((c) => c.key), ['meoh', 'etoh', 'meg', 'deg', 'teg'], 'THI list');
      const map = { meoh: 'methanol', etoh: null, meg: 'meg', deg: 'deg', teg: 'teg' };
      thi.forEach((c) => {
        assert.ok(c.thi, c.key + ' thi block');
        assert.strictEqual(c.thi.hamKey, map[c.key], c.key + ' hamKey');
        assert.within(c.leanDef, c.leanMin, c.leanMax, c.key + ' lean default');
        assert.ok(c.thi.maxPct === 70, c.key + ' ✗ above 70 wt %');
        assert.strictEqual(c.water, 0, c.key + ': lean water handled by X_L');
      });
      // Hammerschmidt constants agree with the 25-hydrate.js engine for the mapped keys.
      const W = app.win;
      ['meoh', 'meg', 'deg', 'teg'].forEach((k) => {
        const t = C.find(k).thi;
        const engine = W.WTS_hammerschmidt_depression(25, t.hamKey);
        assert.near(t.K * 25 / (t.Mham * 75), engine, 1e-9, k + ' K/M match the engine');
      });
      assert.strictEqual(C.find('etoh').thi.M, 46.07, 'ethanol local M');
      assert.strictEqual(C.find('deg').thi.nb, false, 'DEG: Hammerschmidt only');
      assert.strictEqual(C.find('teg').thi.nb, false, 'TEG: Hammerschmidt only');
      assert.strictEqual(C.find('meoh').thi.warnPct, 50, 'MeOH ⚠ above 50 wt %');
      assert.strictEqual(C.find('meg').thi.warnPct, 60, 'MEG ⚠ above 60 wt %');
      eq(assert, [C.find('meoh').leanDef, C.find('etoh').leanDef, C.find('meg').leanDef, C.find('deg').leanDef, C.find('teg').leanDef],
        [100, 95, 80, 90, 95], 'lean defaults');
      // Freeze curves (§4.3) and the H1 rich phase (38.14 wt % methanol → ≈ −33.7 °F).
      function interp(curve, w) {
        for (let i = 1; i < curve.length; i++) {
          if (w <= curve[i][0]) { const a = curve[i - 1], b = curve[i]; return a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0]); }
        }
        return curve[curve.length - 1][1];
      }
      const m = C.find('meoh').freezeCurve, g = C.find('meg').freezeCurve;
      eq(assert, m.slice(1), [[20, 5], [30, -15], [40, -38], [50, -65]], 'methanol–water points');
      eq(assert, g.slice(1), [[20, 18], [30, 5], [40, -11], [50, -33], [60, -54]], 'MEG–water points');
      assert.near(interp(m, 38.14), -33.7, 0.1, 'H1 rich-phase freeze point');
      // MEG 80 wt % solution density by ideal mixing: 9.093 lb/gal (H1 MEG variant).
      const rhoMeg = C.find('meg').sg * C.constants.lbPerGalWater;
      assert.near(1 / (0.8 / rhoMeg + 0.2 / C.constants.lbPerGalWater), 9.093, 0.001, 'MEG 80 wt % lb/gal');
      // LDHI screening limits (§4.6).
      eq(assert, [C.find('khi').ldhi.subMaxF, C.find('khi').ldhi.subAdvF], [15, 27], 'KHI subcooling limits');
      assert.ok(C.find('aa').ldhi.needsLHC && C.find('aa').ldhi.maxWaterCutPct === 50, 'AA needs liquid HC, water cut ≤ 50 %');
    },
  },
  {
    name: 'CHEM chemlib suitability: the plan §3.3 matrix cell by cell, chemical overrides, ranked points never ✗, N38 verdicts',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib;
      Object.keys(MATRIX).forEach((fk) => {
        const f = C.family(fk);
        assert.ok(f, 'family ' + fk);
        POINTS.forEach((p, i) => assert.strictEqual(f.suit[p], MATRIX[fk][i], fk + ' at ' + p));
      });
      // Overrides from the plan's parentheses: MMA-triazine sepoil A, glyoxal sepwat A.
      assert.strictEqual(C.suit('h2s_mma_triazine', 'sepoil'), 'A', 'MMA at sepoil');
      assert.strictEqual(C.suit('h2s_mea_triazine', 'sepoil'), 'N', 'MEA at sepoil');
      assert.strictEqual(C.suit('h2s_glyoxal', 'sepwat'), 'A', 'glyoxal at sepwat');
      assert.strictEqual(C.suit('h2s_mea_triazine', 'sepwat'), 'N', 'MEA at sepwat');
      // Every chemical: its ranked points are never ✗ and the first one is ✓ (R or A).
      C.chemicals.forEach((c) => {
        assert.ok(c.points.length > 0, c.key + ' has points');
        assert.strictEqual(new Set(c.points).size, c.points.length, c.key + ' no duplicate points');
        c.points.forEach((p) => assert.notStrictEqual(C.suit(c.key, p), 'X', c.key + ' ranked point ' + p));
        assert.ok(['R', 'A'].indexOf(C.suit(c.key, c.points[0])) !== -1, c.key + ' first point is ✓');
      });
      // N38: MEA-triazine at dh ⚠ N; nitrite at wh ✗ X; antifoam at sepgas ✗ X; nitrite at tank ⚠ N (oxidiser note).
      const s = (k, p) => C.suitInfo(k, p);
      eq(assert, [s('h2s_mea_triazine', 'dh').level, s('h2s_mea_triazine', 'dh').verdict], ['N', 'warn'], 'MEA at dh');
      eq(assert, [s('h2s_nitrite', 'wh').level, s('h2s_nitrite', 'wh').verdict], ['X', 'bad'], 'nitrite at wh');
      eq(assert, [s('af_silicone', 'sepgas').level, s('af_silicone', 'sepgas').verdict], ['X', 'bad'], 'antifoam at sepgas');
      const nt = s('h2s_nitrite', 'tank');
      assert.strictEqual(nt.level, 'N', 'nitrite at tank');
      assert.includes(nt.note, 'Oxidiser', 'oxidiser note');
      assert.includes(s('meoh', 'dsch').note, 'choke body and bean are not protected', 'THI downstream of choke');
      assert.strictEqual(s('meoh', 'wh').verdict, 'ok', 'methanol upstream of choke');
      C.chemicals.forEach((c) => POINTS.forEach((p) => {
        const i = s(c.key, p);
        assert.ok(i && i.note && i.note.length < 299 && !/[<>&]/.test(i.note), c.key + '/' + p + ' note');
      }));
    },
  },
  {
    name: 'CHEM chemlib scavengers and points: η defaults (§3.4), stoichiometry gives R_th 0.8691 / R 1.4984 (N19), MMA and glyoxal ≈ 1.0 gal/lb',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib, K = C.constants;
      // Point defaults.
      eq(assert, POINTS.map((p) => C.point(p).etaScav), [null, 0.58, 0.50, 0.45, 0.40, null, null, null, null], 'η by point');
      assert.strictEqual(C.eff('h2s_mea_triazine', 'wh'), 0.58, 'MEA η at wh');
      assert.strictEqual(C.eff('h2s_mea_triazine', 'sepgas'), 0.40, 'MEA η at sepgas');
      assert.strictEqual(C.eff('h2s_mma_triazine', 'dsch'), 0.55, 'MMA η');
      assert.strictEqual(C.eff('h2s_glyoxal', 'wh'), 0.40, 'glyoxal η');
      assert.strictEqual(C.eff('meoh', 'wh'), null, 'not a scavenger');
      // R_th (gal/lb H2S) = (MW/(n·34.081)) / (active·8.337·SG); R = R_th/η.
      function rth(k) {
        const c = C.find(k), s = c.stoich;
        return (s.mw / (s.n * K.mwH2S)) / (s.activePct / 100 * K.lbPerGalWater * c.sg);
      }
      assert.near(rth('h2s_mea_triazine'), 0.8691, 0.0005, 'MEA R_th');
      assert.near(rth('h2s_mea_triazine') / C.eff('h2s_mea_triazine', 'wh'), 1.4984, 0.001, 'MEA R at wh');
      assert.near(C.find('h2s_mea_triazine').stoich.mw / (2 * K.mwH2S), 3.217, 0.001, 'MEA 3.217 lb active/lb H2S');
      assert.near(rth('h2s_mma_triazine') / C.eff('h2s_mma_triazine', 'wh'), 1.0, 0.05, 'MMA → 1.0 gal/lb');
      assert.near(rth('h2s_glyoxal') / C.eff('h2s_glyoxal', 'wh'), 1.0, 0.05, 'glyoxal → 1.0 gal/lb');
      // R stays in WTS_h2s_scavenger's 0.1–10 gal/lb: MEA-triazine η ≥ 0.087.
      assert.ok(rth('h2s_mea_triazine') / 0.087 <= 10 && rth('h2s_mea_triazine') / 0.086 > 10, 'MEA η clamp at 0.087');
      // Points (§3.1): pressure / back-pressure bases, phases, contact segments.
      const pt = (k) => C.point(k);
      eq(assert, POINTS.map((k) => pt(k).pLine), ['dh', 'wh', 'ck', 'sep', 'sep', 'bpv', 'sep', 'sep', 'atm'], 'pressure basis');
      eq(assert, POINTS.map((k) => pt(k).pBack), ['sithp', 'sithp', 'psvsep', 'psvsep', 'psvsep', 'psvsep', 'psvsep', 'psvsep', 'none'], 'P_back');
      eq(assert, POINTS.map((k) => pt(k).pBackClass), ['whclass', 'whclass', 'psvsep', 'psvsep', 'psvsep', 'psvsep', 'psvsep', 'psvsep', 'none'], 'full-class basis');
      assert.ok(pt('dh').wellbore && pt('wh').wellbore && !pt('dsch').wellbore, 'wellbore-connected points');
      assert.ok(pt('sepgas').phases.gas && !pt('sepgas').phases.water && pt('sepwat').phases.water && !pt('sepwat').phases.gas, 'phases');
      eq(assert, [pt('wh').contactSegs, pt('dsch').contactSegs, pt('sepin').contactSegs, pt('sepin').contactSegsHeater],
        [[1, 2, 3, 4], [2, 3, 4], [3, 4], [4]], 'contact segments');
      assert.ok(['dh', 'wh', 'dsch', 'sepin'].every((k) => pt(k).upstreamOfSep) && !pt('sepgas').upstreamOfSep, 'upstream of the separator');
      for (let i = 1; i < 4; i++) assert.ok(pt(POINTS[i]).order > pt(POINTS[i - 1]).order, 'well-branch order');
      C.points.forEach((p) => assert.ok(p.label && p.short && p.pumpClass && !/[<>&]/.test(p.label + p.short + p.note), p.key + ' text'));
    },
  },
  {
    name: 'CHEM chemlib pumps: presets (§5.2), plunger geometry (N24), pneumatic / rod / ratio pressure envelopes (§4.10.3), H1 air-driven numbers',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib, K = C.constants;
      eq(assert, C.pumps.map((p) => p.key),
        ['pneu_plunger', 'air_liquid', 'elec_plunger', 'elec_hyd_diaph', 'elec_solenoid', 'elec_mech_diaph', 'air_diaph', 'hand'], 'pump keys');
      const kinds = { pneu_plunger: 'plunger', air_liquid: 'airliquid', elec_plunger: 'plunger', elec_hyd_diaph: 'meter', elec_solenoid: 'meter', elec_mech_diaph: 'meter', air_diaph: 'transfer', hand: 'hand' };
      C.pumps.forEach((p) => {
        assert.strictEqual(p.kind, kinds[p.key], p.key + ' kind');
        assert.ok(['spm', 'stroke_speed', 'air', 'cycles', 'batch'].indexOf(p.setting) !== -1, p.key + ' setting');
        assert.ok(['pneumatic', 'rod', 'fixed', 'ratio'].indexOf(p.pmaxRule) !== -1, p.key + ' pmaxRule');
        assert.strictEqual(p.hazSuitable, !p.electric, p.key + ': electric pumps rank after pneumatic in a classified area');
        assert.ok(p.name && p.short && p.hazAreaNote && !/[<>&]/.test(p.name + p.hazAreaNote + p.accuracy + p.turndown), p.key + ' text');
        p.bestPoints.forEach((k) => assert.ok(C.point(k), p.key + ' best point ' + k));
        if (p.plungers) p.plungers.forEach((d) => assert.ok(C.plungers.some((x) => x.in === d), p.key + ' plunger ' + d + ' in the list'));
        if (p.strokes) p.strokes.forEach((L) => assert.ok(C.strokes.some((x) => x.in === L), p.key + ' stroke ' + L + ' in the list'));
      });
      assert.strictEqual(C.pump('hand').mvp, false, 'hand pump is Phase 2');
      assert.strictEqual(C.pumps.filter((p) => p.mvp).length, 7, 'seven pumps in the 3.2a select');
      const pn = C.pump('pneu_plunger'), el = C.pump('elec_plunger'), air = C.pump('air_liquid');
      eq(assert, [pn.spmMax, pn.spmMin, pn.bodyPsi, pn.etaM, pn.pSpring, pn.headsMax], [60, 3, 10000, 0.8, 5, 2], 'pneumatic preset');
      eq(assert, Array.from(pn.actuators), [4, 6, 8], 'actuators');
      eq(assert, [el.spmCrank, el.rodLbf, el.capPsi, el.headsMax, el.strokeMax, el.sMin, el.nMin, el.vfd], [120, 2500, 15000, 3, 1, 10, 10, false], 'electric plunger preset');
      eq(assert, [air.q0_galh, air.ratio, air.vcyc_in3, air.bodyPsi, air.stallFracMax, air.q0FracMin], [30, 100, 1.0, 10000, 0.7, 0.1], 'air-driven preset');
      eq(assert, [C.pump('elec_solenoid').sMin, C.pump('elec_mech_diaph').sMin, C.pump('elec_hyd_diaph').sMin], [20, 20, 10], 'S_min');
      eq(assert, [C.pump('elec_hyd_diaph').pmax, C.pump('elec_solenoid').pmax, C.pump('elec_mech_diaph').pmax], [3000, 150, 250], 'metering P_max');
      assert.near(C.pump('elec_solenoid').qRated_galh * 24, 63.4, 0.05, 'solenoid 10 L/h = 63.4 gal/d');
      assert.strictEqual(C.defaults.thiDefaultPump, 'air_liquid', 'Q19 default hydrate pump');
      assert.ok(C.pump(C.defaults.thiDefaultPump).hazSuitable, 'default hydrate pump has no electrics');
      // Plunger geometry (§4.10.1): V_s = π/4·d²·L; mL/stroke and gal/d per SPM at L = 1 in.
      const mL = [0.452, 0.804, 1.257, 1.810, 3.218, 5.027, 7.240, 9.854, 12.87, 20.11];
      const gpd = [0.172, 0.306, 0.478, 0.689, 1.224, 1.912, 2.754, 3.748, 4.896, 7.650];
      assert.strictEqual(C.plungers.length, 10, 'ten plunger sizes');
      C.plungers.forEach((p, i) => {
        const vs = Math.PI / 4 * p.in * p.in;
        assert.near(vs * K.mLPerIn3, mL[i], 0.006, p.frac + ' mL/stroke');
        assert.near(vs * 1440 / K.in3PerGal, gpd[i], 0.001, p.frac + ' gal/d per SPM');
        assert.strictEqual(p.value, String(p.in), p.frac + ' select value');
        assert.ok(/ in \(\d+(\.\d)? mm\)$/.test(p.label), p.frac + ' label shows both units: ' + p.label);
      });
      assert.strictEqual(C.plungers[3].label, '3/8 in (9.5 mm)', '3/8 label');
      const v38 = Math.PI / 4 * 0.375 * 0.375;
      assert.near(v38, 0.110447, 1e-6, 'N24 in³');
      assert.near(v38 * K.mLPerIn3, 1.8099, 1e-4, 'N24 mL');
      assert.near(v38 * 1440 / 231, 0.68850, 1e-5, 'N24 gal/d per SPM');
      eq(assert, C.strokes.map((s) => s.frac), ['1/4', '1/2', '3/4', '1', '1-1/4', '1-1/2', '2'], 'stroke list');
      eq(assert, C.actuators.map((s) => s.label), ['4 in (102 mm)', '6 in (152 mm)', '8 in (203 mm)'], 'actuator list');
      // Pneumatic P_max = min(body, η_m·P_s·A_act/(n_h·A_pl)) at 100 psig, simplex (§4.10.3 table).
      const pmaxPn = (d, D, n) => Math.min(pn.bodyPsi, pn.etaM * 100 * D * D / ((n || 1) * d * d));
      [[0.375, 4, 9102], [0.5, 4, 5120], [0.75, 4, 2276], [1, 4, 1280], [0.375, 6, 10000], [0.75, 6, 5120], [1, 6, 2880], [0.75, 8, 9102], [1, 8, 5120]]
        .forEach(([d, D, v]) => assert.near(pmaxPn(d, D), v, 1, d + ' in plunger, ' + D + ' in actuator'));
      assert.near(pmaxPn(1, 8, 2), 2560, 1, '8 in, 1 in duplex (H1 N28)');
      assert.near(pmaxPn(0.75, 8, 2), 4551, 1, '8 in, 3/4 in duplex');
      // Electric plunger P_max = min(cap, F_rod/A_pl): 5/8 → 8,149; 3/4 → 5,659; 7/8 → 4,158; 1 → 3,183 psi.
      [[0.625, 8149], [0.75, 5659], [0.875, 4158], [1, 3183]].forEach(([d, v]) =>
        assert.near(Math.min(el.capPsi, el.rodLbf / (Math.PI / 4 * d * d)), v, 1, d + ' in rod-load limit'));
      // H1 electric alternative: Q_max = 4.896·d²·L·SPM·ηv = 404.8 gal/d → 159.95 gal/d at 39.5 % stroke.
      const qmax = K.galDPerSpmD2L * 0.875 * 0.875 * 1 * el.spmCrank * el.etaDef;
      assert.near(100 * 159.95 / qmax, 39.5, 0.1, 'H1 7/8 in electric plunger % stroke');
      // H1 air-driven (§4.10.3): Q(P) = Q₀·(1 − P/(r·P_air)); P_air = P_d/(r·(1 − Q/Q₀)).
      const q0 = air.q0_galh * 24;
      assert.near(q0 * (1 - 3550 / (air.ratio * 100)), 464.4, 0.1, 'flow at 3550 psig with full air');
      assert.near(3550 / (air.ratio * (1 - 159.95 / q0)), 45.6, 0.1, 'air setting');
      assert.near(3550 / (air.ratio * (1 - 2 * 159.95 / q0)), 63.9, 0.1, 'peak air setting');
      assert.near(159.95 * 231 / 1440 / air.vcyc_in3, 25.7, 0.05, 'cycles/min');
    },
  },
  {
    name: 'CHEM chemlib tables: capillary lines (§5.3), dose bases and metric twins, compatibility rules (§5.4, N37 pairs), elastomers, decided defaults',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_chemlib;
      // Capillary: ID = OD − 2·wall; Barlow 2·S·t/OD at 20 ksi, to 10 psi.
      const cap = { c250_035: [0.180, 4.57, 5600], c250_049: [0.152, 3.86, 7840], c375_049: [0.277, 7.04, 5230], c375_065: [0.245, 6.22, 6930] };
      eq(assert, C.capillary.map((c) => c.key), Object.keys(cap), 'capillary keys');
      Object.keys(cap).forEach((k) => {
        const c = C.cap(k);
        assert.near(c.id, cap[k][0], 1e-9, k + ' ID');
        assert.near(c.idMm, cap[k][1], 0.005, k + ' ID mm');
        assert.strictEqual(c.barlowPsi, cap[k][2], k + ' Barlow');
        assert.near(c.barlowPsi, 2 * 20000 * c.wall / c.od, 10, k + ' Barlow formula');
      });
      assert.strictEqual(C.cap('c250_049').label, '1/4 × 0.049 in capillary (ID 3.86 mm)', 'capillary label (§2.4)');
      // Bases: every key self-named; twins point back with reciprocal factors.
      const want = ['ppmv_oil', 'ppmv_water', 'ppmv_liq', 'ppmw_water', 'ppmw_oil', 'pt_mmscf', 'gal_mmscf', 'l_1e6sm3', 'vol_water',
        'wt_water', 'gal_lb_h2s', 'l_kg_h2s', 'ppm_per_ppm_liq', 'ppm_per_ppm_o2', 'batch_gal'];
      eq(assert, Object.keys(C.bases).sort(), want.slice().sort(), 'the §4.9 bases');
      want.forEach((k) => {
        const b = C.bases[k];
        assert.strictEqual(b.key, k, k + ' key');
        assert.ok(b.label && b.unit && b.phase, k + ' label/unit/phase');
        if (/^ppm[vw]_/.test(k)) assert.includes(b.label, 'product, as supplied', k + ' says product');
      });
      assert.near(C.bases.gal_mmscf.factor * C.bases.l_1e6sm3.factor, 1, 1e-12, 'gal/MMscf ↔ L/10⁶ Sm³');
      assert.near(C.bases.gal_mmscf.factor, 133.681, 0.001, 'doseGasVol factor (§6.5)');
      assert.near(C.bases.gal_lb_h2s.factor * C.bases.l_kg_h2s.factor, 1, 1e-12, 'gal/lb ↔ L/kg');
      assert.near(C.bases.pt_mmscf.factor, C.bases.gal_mmscf.factor / 8, 0.01, '1 US pt = 1/8 gal');
      // Compatibility (§5.4): pair rules by tags; N37.
      const keysOf = (rs) => rs.map((r) => r.key).sort();
      eq(assert, keysOf(C.pairRules('h2s_nitrite', 'h2s_mea_triazine')), ['amine_nitrite', 'organic_oxidiser'], 'nitrite + MEA-triazine');
      assert.ok(C.pairRules('h2s_mea_triazine', 'h2s_nitrite').every((r) => r.level === 'bad'), 'both ✗, either order');
      eq(assert, keysOf(C.pairRules('meoh', 'si_phosphonate')), ['methanol_si'], 'methanol + phosphonate ⚠');
      eq(assert, keysOf(C.pairRules('h2s_glyoxal', 'o2_scavenger')), ['aldehyde_bisulfite'], 'aldehyde + bisulfite ✗');
      eq(assert, keysOf(C.pairRules('h2s_mea_triazine', 'h2s_glyoxal')), ['triazine_aldehyde'], 'triazine + glyoxal ⚠');
      assert.ok(keysOf(C.pairRules('h2s_mea_triazine', 'si_phosphonate')).indexOf('triazine_acidic_si') !== -1, 'triazine + acidic SI');
      eq(assert, keysOf(C.pairRules('ci_film_liq', 'si_polymer')), ['cationic_anionic'], 'cationic CI + anionic SI');
      eq(assert, keysOf(C.pairRules('demulsifier', 'af_silicone')), ['ci_antifoam'], 'demulsifier + antifoam');
      eq(assert, keysOf(C.pairRules('meoh', 'meg')), [], 'methanol + MEG compatible');
      eq(assert, keysOf(C.pairRules('custom', 'h2s_peroxide')), [], 'custom has no tags');
      eq(assert, keysOf(C.ctxRules('h2s_peroxide')), ['oxidiser_hc_tank'], 'peroxide in a hydrocarbon tank');
      eq(assert, keysOf(C.ctxRules('h2s_mea_triazine')), ['aq_scav_sepgas', 'triazine_ca_water'], 'MEA-triazine context rules');
      eq(assert, keysOf(C.ctxRules('af_silicone')), ['silicone_sale_crude'], 'silicone antifoam');
      eq(assert, keysOf(C.ctxRules('h2s_glyoxal')), ['aq_scav_sepgas', 'glyoxal_carbon_steel'], 'glyoxal');
      const allTags = new Set([].concat.apply([], C.chemicals.map((c) => Array.from(c.incompat))));
      C.compat.forEach((r) => {
        assert.ok(r.level === 'bad' || r.level === 'warn', r.key + ' level');
        assert.ok((r.b && !r.ctx) || (!r.b && r.ctx), r.key + ' is a pair rule or a context rule');
        assert.ok(r.text.length > 0 && r.text.length < 299 && !/[<>&]/.test(r.text), r.key + ' text');
        r.a.concat(r.b || []).forEach((t) => assert.ok(allTags.has(t), r.key + ': tag "' + t + '" is carried by a chemical'));
      });
      // Elastomers (§5.5).
      const E = C.elastomer;
      eq(assert, Array.from(E.materials), ['NBR', 'HNBR', 'EPDM', 'FKM std', 'FKM peroxide', 'FFKM', 'PTFE'], 'materials');
      Object.keys(E.rows).forEach((k) => E.materials.forEach((m) => assert.ok(['A', 'A-B', 'B', 'B-C', 'C'].indexOf(E.rows[k][m]) !== -1, k + ' ' + m)));
      assert.strictEqual(C.elastomerRow('meoh')['FKM std'], 'C', 'avoid standard FKM with methanol');
      assert.strictEqual(C.elastomerRow('h2s_mea_triazine').EPDM, 'A', 'triazine EPDM');
      assert.strictEqual(C.elastomerRow('demulsifier'), null, 'no row → null');
      C.chemicals.forEach((c) => { if (c.elastomer) assert.ok(E.rows[c.elastomer], c.key + ' elastomer row exists'); });
      assert.ok(E.note.length < 299, 'elastomer note');
      // Decided design-basis defaults (Q5, Q17, Q18, Q19) and H1 segments.
      const D = C.defaults;
      eq(assert, [D.marginF, D.marginMinF, D.fJT, D.fJTRelaxed, D.fJTMin, D.fJTMax], [10, 5, 1.10, 1.05, 1.00, 1.30], 'margin and J-T factor');
      eq(assert, [D.sourPerMolF, D.sourNoAdderMolPct, D.sourMaxMolPct, D.co2AdderMolPct, D.co2MaxMolPct], [5, 0.1, 3, 5, 20], 'sour limits');
      eq(assert, [D.thiDefaultChem, D.thiDefaultPoint, D.thiDefaultPump], ['meoh', 'wh', 'air_liquid'], 'H1 line 1');
      eq(assert, [D.pumpMarginPct, D.pumpMarginPsi, D.dpQuillPsi, D.bandGreenPct, D.bandAmberPct], [10, 100, 50, 70, 85], 'pump margins and bands');
      eq(assert, D.segments.map((s) => [s.len_ft, s.id_in]), [[20, 2.9], [60, 3.826], [200, 2.9], [80, 3.826]], 'pipe segments');
      assert.near(C.constants.psiPerFtPerSg, 0.052 * 8.337, 1e-4, 'liquid gradient');
    },
  },
  {
    name: 'CHEM gaspvt N7: isenthalpic choke (raw DAK and design × 1.10) matches the plan within 0.3 °F in ≤ 6 Newton steps',
    wp: WP,
    run(app, assert) {
      const W = app.win, I = W.WTS_gaspvt_isenthalpic;
      assert.fn(I, 'WTS_gaspvt_isenthalpic');
      assert.fn(I.stats, 'stats()');
      // γ 0.65: [T1 °F, P1, P2 psia, DAK °F, design °F]
      [[110, 3014.7, 1014.7, 41.42, 34.56], [100, 2000, 500, 25.26, 17.78], [80, 1000, 100, 24.24, 18.67],
        [60, 3514.7, 1014.7, -18.81, -26.69], [90, 1014.7, 264.7, 47.51, 43.27], [100, 999.7, 314.7, 63.55, 59.90]]
        .forEach(([t1, p1, p2, dak, des]) => {
          const r = I({ sg: 0.65, p1, t1, p2, fJT: W.WTS_chemlib.defaults.fJT });
          const tag = t1 + ' °F ' + p1 + ' → ' + p2 + ' psia';
          assert.ok(r.ok, tag + ' ok');
          assert.near(r.t2, dak, 0.3, tag + ' DAK');
          assert.near(r.t2Design, des, 0.3, tag + ' design');
          assert.near(r.t2Design, t1 - 1.10 * (t1 - r.t2), 1e-9, tag + ' design = T1 − f·(T1 − T2)');
          assert.ok(r.iterations >= 1 && r.iterations <= 6, tag + ' iterations ' + r.iterations);
          assert.near(r.dT, r.t2 - t1, 1e-12, tag + ' dT = t2 − t1');
          assert.near(r.cooling, t1 - r.t2, 1e-12, tag + ' cooling');
          assert.strictEqual(r.clamped, false, tag + ' not clamped');
          assert.ok(Array.isArray(r.warnings), tag + ' warnings');
        });
      // N8 counterpart: the 7 °F/100 psi rule gives −30 °F for H1 (cheminj option) — the real-gas value is far warmer.
      // The 7 °F/100 psi rule gives 110 − 0.07 × 2000 = −30 °F for H1 (N8): it overstates cooling for drops from above ~2000 psi.
      assert.ok(I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1014.7 }).t2 - (110 - 0.07 * 2000) > 60, 'rule overstates the H1 cooling');
      // Without fJT there is no design value.
      const raw = I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1014.7 });
      assert.ok(!('t2Design' in raw), 'no t2Design without fJT');
    },
  },
  {
    name: 'CHEM gaspvt V1: methane μJT (DAK, Sutton at γ 0.5539, real-gas Cp) within 0.95–1.10 of NIST at 8 points; f_JT 1.10 ≥ the largest ratio',
    wp: WP,
    run(app, assert) {
      const W = app.win, E = W.WTS_gaspvt_enthalpy;
      assert.fn(E, 'WTS_gaspvt_enthalpy');
      // Plan §4.1.3 DAK column (K/MPa): the solver's own μJT reproduces the prototype.
      const DAK = [3.969, 3.885, 3.680, 3.077, 6.197, 6.033, 5.617, 4.001];
      let worst = 0;
      NIST.forEach(([TK, MPa, nist], i) => {
        const e = E({ sg: 0.5539, p: MPa * PSI_PER_MPA, t: TK * 1.8 - 459.67 });
        assert.ok(e.ok, TK + ' K ' + MPa + ' MPa ok');
        const kMPa = e.muJT_Fpsi / 1.8 * PSI_PER_MPA;
        assert.near(kMPa, DAK[i], 0.02, TK + ' K ' + MPa + ' MPa DAK μJT');
        const ratio = nist / kMPa;
        assert.within(ratio, 0.95, 1.10, TK + ' K ' + MPa + ' MPa NIST/DAK');
        worst = Math.max(worst, ratio);
      });
      assert.within(worst, 1.08, 1.095, 'largest NIST/DAK ratio (plan 1.089)');
      assert.ok(W.WTS_chemlib.defaults.fJT >= worst, 'default J-T factor covers the methane bias');
    },
  },
  {
    // The Katz chart readings (≈ 1100 psia at 100 °F, ≈ 400 psia at 120 °F) are from memory / a
    // secondary source in the plan (§4.1.3, [M] and [L–M]). They MUST be confirmed against the
    // permissible-expansion figure in the GPSA Engineering Data Book before release (plan §9.1 item 5);
    // until then the test uses the plan's stated tolerance (±150 psia) around the design values.
    name: 'CHEM gaspvt V2: Katz permissible expansion from 2000 psia, γ 0.6 — design × 1.10 limits 1130 ±150 psia (100 °F) and 510 ±150 psia (120 °F)',
    wp: WP,
    run(app, assert) {
      const W = app.win, I = W.WTS_gaspvt_isenthalpic;
      assert.near(W.WTS_hydrate_temp(1014.7, 0.65), 63.13, 0.01, 'Towler–Mokhatab at 1014.7 psia, γ 0.65 (N3)');
      // Lowest P2 that stays out of the hydrate region (T2 ≥ T_hyd(P2)), scanning down from P1.
      function lowest(t1, f) {
        const p1 = 2000;
        const m = (p2) => { const r = I({ sg: 0.6, p1, t1, p2 }); return (t1 - f * (t1 - r.t2)) - W.WTS_hydrate_temp(p2, 0.6); };
        for (let p = p1 - 25; p >= 14.7; p -= 25) {
          if (m(p) < 0) {
            let a = p, b = p + 25;
            for (let k = 0; k < 30; k++) { const c = (a + b) / 2; if (m(c) < 0) a = c; else b = c; }
            return (a + b) / 2;
          }
        }
        return null;   // permissible to atmospheric
      }
      const f = W.WTS_chemlib.defaults.fJT;
      const d100 = lowest(100, f), r100 = lowest(100, 1), d120 = lowest(120, f), r120 = lowest(120, 1);
      assert.ok(d100 != null && r100 != null, '100 °F limited both ways');
      assert.near(d100, 1130, 150, '100 °F at design');
      assert.near(r100, 1040, 150, '100 °F with DAK alone');
      assert.ok(d100 > r100, 'the factor is conservative (higher final pressure)');
      assert.ok(d120 != null, '120 °F limited at design');
      assert.near(d120, 510, 150, '120 °F at design');
      assert.strictEqual(r120, null, '120 °F with DAK alone: no limit (the case the factor fixes)');
      assert.strictEqual(lowest(140, f), null, '140 °F: permissible to atmospheric');
    },
  },
  {
    name: 'CHEM gaspvt WTS_gaspvt_z / _enthalpy: mol % inputs, compute() identity, no −40 °F floor, Tpr ≥ 1 guard, S1 contact-time Z (N22), Cp = ∂h/∂T',
    wp: WP,
    run(app, assert) {
      const W = app.win, Z = W.WTS_gaspvt_z, E = W.WTS_gaspvt_enthalpy, F = W.WTS_gaspvt_compute;
      assert.fn(Z, 'WTS_gaspvt_z');
      // Identity with compute() (same DAK, same pseudo-criticals, mol % impurities).
      const c = F({ sg: 0.7, p: 3000, t: 200, co2: 5, h2s: 10, n2: 2 });
      const z = Z({ sg: 0.7, p: 3000, t: 200, co2: 5, h2s: 10, n2: 2 });
      assert.ok(c.ok && z.ok, 'both ok');
      assert.rel(z.z, c.zDAK, 1e-12, 'Z = compute().zDAK');
      assert.rel(z.Bg_ft3scf, c.Bg_ft3scf, 1e-12, 'Bg');
      assert.rel(z.Tpc, c.Tpc, 1e-12, 'Tpc (Wichert–Aziz)');
      assert.rel(z.Tpc, W.WTS_gaspvt_pseudoCriticals(0.7, 0.05, 0.10, 0.02).Tpc, 1e-12, 'impurities read as mol %');
      assert.ok(Array.isArray(z.warnings), 'warnings');
      // N3: 20,000 ppm H2S converted to 2.0 mol % is fine; the raw 20,000 is refused.
      assert.strictEqual(Z({ sg: 0.65, p: 1014.7, t: 34.56, h2s: 2.0 }).ok, true, 'h2s 2.0 mol %');
      const bad = Z({ sg: 0.65, p: 1014.7, t: 34.56, h2s: 20000 });
      assert.strictEqual(bad.ok, false, 'h2s 20000 refused');
      assert.ok(Array.from(bad.bad).indexOf('h2s') !== -1, 'bad field h2s');
      // No −40 °F floor: −60 °F at 500 psia (Tpr 1.09) works here, compute() refuses it.
      const cold = Z({ sg: 0.65, p: 500, t: -60 });
      assert.ok(cold.ok && cold.Tpr > 1 && cold.z > 0.5 && cold.z < 1, 'below −40 °F');
      assert.strictEqual(F({ sg: 0.65, p: 500, t: -60 }).ok, false, 'compute() keeps its −40 °F limit');
      const below = Z({ sg: 0.65, p: 500, t: -120 });
      assert.strictEqual(below.ok, false, 'Tpr < 1 refused');
      assert.strictEqual(below.keys[0], 'tpc', 'pseudo-critical error');
      assert.strictEqual(Z({ sg: 0.4, p: 500, t: 60 }).ok, false, 'gravity range');
      assert.strictEqual(Z({ sg: 0.65, p: 0, t: 60 }).ok, false, 'pressure > 0');
      // S1 contact segments (§4.13): Z 0.871 / 0.945 / 0.958 / 0.959.
      [[999.7, 100, 0.871], [314.7, 59.9, 0.945], [309.7, 100, 0.958], [299.7, 100, 0.959]]
        .forEach(([p, t, zz]) => assert.near(Z({ sg: 0.65, p, t }).z, zz, 0.005, 'S1 Z at ' + p + ' psia'));
      // Bg = 0.02827·Z·T/P (the plan's contact-time constant).
      const s1 = Z({ sg: 0.65, p: 999.7, t: 100 });
      assert.rel(s1.Bg_ft3scf, 0.0282794 * s1.z * 559.67 / 999.7, 1e-5, 'Bg constant');
      // Enthalpy: real-gas Cp agrees with compute()'s Simpson value; Cp = ∂h/∂T; μJT = −(∂h/∂p)_T / Cp.
      const e = E({ sg: 0.7, p: 3000, t: 200 });
      const c0 = F({ sg: 0.7, p: 3000, t: 200 });
      assert.ok(e.ok, 'enthalpy ok');
      assert.rel(e.cp_JmolK, c0.cpReal, 1e-3, 'Cp vs compute().cpReal');
      assert.rel(e.cpIdeal_JmolK, c0.cp, 1e-12, 'Cp° vs compute().cp');
      assert.near(e.h_Jmol, e.hIdeal_Jmol + e.hRes_Jmol, 1e-9, 'h = h° + (h − h°)');
      const h = (p, t) => E({ sg: 0.65, p, t }).h_Jmol;
      const mid = E({ sg: 0.65, p: 1014.7, t: 40 });
      assert.rel((h(1014.7, 41) - h(1014.7, 39)) / (2 / 1.8), mid.cp_JmolK, 2e-3, 'Cp = ∂h/∂T');
      const dhdp = (h(1024.7, 40) - h(1004.7, 40)) / 20;    // J/mol per psi
      assert.rel(-dhdp / mid.cp_JmolK * 1.8, mid.muJT_Fpsi, 5e-3, 'μJT = −(∂h/∂p)_T / Cp');
      assert.near(E({ sg: 0.65, p: 14.7, t: 60 }).hIdeal_Jmol, 0, 1e-9, 'h° = 0 at 60 °F');
      const atm = E({ sg: 0.65, p: 14.7, t: 60 }).hRes_Jmol, hp = E({ sg: 0.65, p: 3000, t: 60 }).hRes_Jmol;
      assert.ok(atm < 0 && Math.abs(atm) < 60 && Math.abs(atm) < Math.abs(hp) / 20, 'small departure at 1 atm: ' + atm + ' vs ' + hp);
    },
  },
  {
    name: 'CHEM gaspvt isenthalpic: 64-entry memo with stats() (repeat = 0 new solves), copies, p2 ≤ p1, clamp at the solver floor, warnings',
    wp: WP,
    run(app, assert) {
      const W = app.win, I = W.WTS_gaspvt_isenthalpic;
      I.clearMemo();
      eq(assert, Object.assign({}, I.stats()), { solves: 0, hits: 0, size: 0 }, 'cleared');
      const a = I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1014.7, fJT: 1.1 });
      const b = I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1014.7, fJT: 1.05 });
      eq(assert, Object.assign({}, I.stats()), { solves: 1, hits: 1, size: 1 }, 'second call is a memo hit');
      assert.strictEqual(b.t2, a.t2, 'same raw t2');
      assert.near(b.t2Design, 110 - 1.05 * (110 - a.t2), 1e-9, 'design factor applied per call');
      a.t2 = -999; a.warnings.push('mutated');
      const c = I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1014.7 });
      assert.ok(c.t2 > 40 && c.warnings.indexOf('mutated') === -1, 'callers get copies');
      // Inputs rounded to 0.001 share an entry; a real change solves again.
      I({ sg: 0.65, p1: 3014.7004, t1: 110, p2: 1014.7 });
      assert.strictEqual(I.stats().solves, 1, 'rounded key');
      I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1000 });
      assert.strictEqual(I.stats().solves, 2, 'new key solves');
      // Bounded at 64 entries, least recently used out.
      for (let k = 0; k < 70; k++) I({ sg: 0.65, p1: 1500, t1: 80, p2: 200 + 10 * k });
      assert.strictEqual(I.stats().size, 64, 'bounded memo');
      const before = I.stats().solves;
      I({ sg: 0.65, p1: 3014.7, t1: 110, p2: 1014.7 });           // evicted long ago
      assert.strictEqual(I.stats().solves, before + 1, 'evicted entry solves again');
      I({ sg: 0.65, p1: 1500, t1: 80, p2: 200 + 10 * 69 });         // most recent
      assert.strictEqual(I.stats().solves, before + 1, 'recent entry is a hit');
      // Input checks.
      const up = I({ sg: 0.65, p1: 1000, t1: 80, p2: 1200 });
      assert.strictEqual(up.ok, false, 'p2 > p1 refused');
      assert.ok(Array.from(up.bad).indexOf('p2') !== -1, 'bad p2');
      assert.strictEqual(I({ sg: 0.65, p1: 1000, t1: 80 }).ok, false, 'missing p2');
      assert.strictEqual(I({ sg: 0.65, p1: 1000, t1: 80, p2: 500, h2s: 30000 }).ok, false, 'ppm passed as mol % is refused');
      assert.strictEqual(I({ sg: 0.65, p1: 1000, t1: 80, p2: 500, h2s: 3 }).ok, true, '3 mol % H2S');
      const same = I({ sg: 0.65, p1: 1000, t1: 50, p2: 1000 });
      assert.ok(same.ok && Math.abs(same.t2 - 50) < 0.01, 'no pressure drop, no temperature change');
      // Cold start beyond the floor: clamped at max(−80 °F, 1.02·Tpc − 459.67) with a warning.
      const cl = I({ sg: 0.65, p1: 5000, t1: -20, p2: 100 });
      assert.ok(cl.ok && cl.clamped, 'clamped');
      assert.near(cl.t2, cl.tFloor, 1e-9, 'at the floor');
      assert.near(cl.tFloor, Math.max(-80, 1.02 * 365.11 - 459.67), 0.01, 'floor value');
      assert.ok(cl.warnings.some((w) => /solver bound/.test(w)) && cl.warnings.some((w) => /below −40 °F/.test(w)), 'clamp and range warnings');
      cl.warnings.forEach((w) => assert.ok(w.length < 299, 'warning < 299 characters'));
      // Start-up case (60 °F tree, 3514.7 → 1014.7 psia) is unclamped and below 0 °F.
      const su = I({ sg: 0.65, p1: 3514.7, t1: 60, p2: 1014.7, fJT: 1.1 });
      assert.ok(su.ok && !su.clamped && su.t2Design < 0, 'start-up');
    },
  },
];
