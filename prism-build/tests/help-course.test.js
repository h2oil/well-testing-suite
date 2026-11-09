// Well Test Simulator course and field scenarios — docs/HELP-GUIDE-PLAN.md §6 and §7.5 (WP-T).
//
// Content: prism-build/48-calc-help-simcourse.js (WTS_helpContent.course / .scenarios). Checks here:
//   • shape: every exercise has goal, set-up, steps, observe, questions, answers, trainer notes (duration, fault and
//     time, good response, mistakes, ≥ 3 debrief questions) and a set-up form of live wts_* ids; FS-1 / FS-2 open with
//     "which pressure goes where" and carry both variants; size limits (§4.6);
//   • live references: tags and alarm ids are read from the engine (WTS_sim.TAGS, the 31-wts-sim.js source), fault
//     menu items from WTS_sim.FAULTS, bold phrases from the page and the HMI source (38-wts-live.js) — never a fixed list;
//   • numbers: CHECKS below reproduce every number quoted in the text. 'page' checks run calcWTS on route wts now (host
//     code, in the harness). 'sim' checks run the dynamic simulator; they run only when Round 7 is in the harness pipeline
//     (sim-equip WP0) or with WTS_HELP_SIMCHECKS=1 (the HTML's injected Round 7), and are skipped with the reason otherwise;
//   • FS-1 / FS-2 select the variant for WTS_sim.features (bypassDest); since 31 v1.5.0 (SIM-FOLLOWUP WP-HC) afterSim is the
//     main text and today a short note, and the references / bold checks cover the variant the engine shows; worksheets print without answers or trainer notes;
//   • sim-equip content (exercises 9-10, FS-3, the §6.4 shot recipes) is added only when the engine has DS-101 and T-202
//     (WTS_sim.RIG_OPTIONAL). Without it the course ships 8 exercises and 3 scenarios; the gated content is still checked
//     for shape, size, CHECKS entries and recipes by building it against a stand-in engine. Checks marked needs: run only
//     when the engine has that item.
// The checks live in this file, not in the content, so they add nothing to the app bundle (D15).
'use strict';

const fs = require('fs');
const path = require('path');

const WP = 'HELPCOURSE';
const BUILD = path.resolve(__dirname, '..');
const SIM_SKIP = 'Round 7 not in the harness';
const simInHarness = () => /['"]concat-round7['"]/.test(fs.readFileSync(path.join(__dirname, '_harness.js'), 'utf8')) || process.env.WTS_HELP_SIMCHECKS === '1';

const FS1 = { wts_Psep: 15, wts_Psurge: 5, wts_Qg: 0.3, wts_Qo: 0, wts_Qw: 2400, wts_Pwh: 500, wts_bean: 32 };
const mix = (a, b) => Object.assign({}, a, b);
// Every course / scenario id must have an entry; [] only with a reason in NO_NUMBERS.
const CHECKS = {
  ex1: [
    { kind: 'page', set: {}, tol: 0.005, expectState: { 'flow.choke.Pout': 157.66, 'flow.choke.Pin': 2999.26, 'flow.choke.ratio': 0.0572, 'flow.choke.regime': 'Critical',
      'flow.choke.QmaxMMscfd': 10.71, 'flow.choke.dTjt': 111.26, 'flow.choke.dP': 2841.6, 'flow.nodes.2.T': 68.74, 'flow.heater.Tout': 150 } },
    { kind: 'page', set: { wts_Psep: 160 }, tol: 0.005, expectState: { 'flow.choke.regime': 'Critical', 'flow.choke.flowLimited': false, 'flow.choke.QmaxMMscfd': 10.71 } },
    { kind: 'sim', run: 120, dt: 1, actions: [{ t: 30, sp: 160 }], expect: [{ at: 33, path: 'sep.SPeff', v: 156, tol: 0.01 }] },
  ],
  ex2: [
    { kind: 'page', set: { wts_bean: 30 }, tol: 0.002, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 9.413 }, expectText: ['Choke is flow-limited — bean 30/64'] },
    { kind: 'page', set: { wts_bean: 28 }, tol: 0.005, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 8.2 } },
    { kind: 'page', set: { wts_bean: 34 }, expectState: { 'flow.choke.flowLimited': false }, absentText: ['Choke is flow-limited'] },
    { kind: 'sim', set: { wts_bean: 30 }, run: 120, expect: [{ alarm: 'CHOKE_LIMIT', from: 0, to: 30 }] },
  ],
  ex3: [],   // its numbers are FS-1's
  ex4: [
    { kind: 'sim', run: 1800, actions: [{ t: 600, fault: 'oilDumpStuckClosed', on: true }, { t: 900, resetESD: false, blocking: 'LSHH_SEP' }, { t: 900, fault: 'oilDumpStuckClosed', on: false }, { t: 1500, resetESD: true }],
      expect: [{ alarm: 'LSH_SEP', from: 720, to: 840 }, { alarm: 'LSHH_SEP', from: 790, to: 900 }, { alarm: 'ESD_TRIPPED', from: 790, to: 900 }, { gap: ['LSH_SEP', 'LSHH_SEP'], max: 60 }] },
    { kind: 'sim', run: 3000, actions: [{ t: 600, fault: 'waterDumpStuckClosed', on: true }], expect: [{ alarm: 'ISHH_SEP', from: 900, to: 2600 }, { noAlarm: 'ESD_TRIPPED' }] },
  ],
  ex5: [
    { kind: 'sim', run: 960, dt: 1, actions: [{ t: 600, esd: true }, { t: 900, resetESD: true }],
      expect: [{ at: 606, path: 'esd.travel', v: 0, tol: 0.001 }, { at: 900, path: 'nodes.wellhead.P', v: 3298, tol: 0.01 }, { at: 917, path: 'esd.travel', v: 1, tol: 0.001 }] },
  ],
  ex6: [
    { kind: 'sim', run: 5400, dt: 5, expect: [{ batch: 1, from: 4000, to: 5000 }, { at: 5400, path: 'gauge.batches.0.tClose', v: 3834, tol: 0.05 }, { at: 5400, path: 'gauge.batches.0.settled', v: true }] },
    { kind: 'sim', run: 12000, dt: 10, actions: [{ t: 600, fault: 'surgePumpFail', on: true }], expect: [{ alarm: 'LAH_GT', from: 8000, to: 11000 }, { alarm: 'LSHH_GT', from: 10000, to: 12000 }, { noAlarm: 'ESD_TRIPPED' }] },
  ],
  ex7: [
    { kind: 'sim', run: 150, dt: 1, actions: [{ t: 120, valve: ['surge', 1, true] }, { t: 120, valve: ['surge', 0, false] }],
      expect: [{ at: 100, path: 'surge.comps.1.pos', v: 0 }, { at: 123, path: 'surge.comps.0.pos', v: 1 }, { at: 123, path: 'surge.comps.0.hold', v: true }, { at: 140, path: 'surge.comps.0.pos', v: 0 },
        { at: 140, path: 'surge.comps.1.pos', v: 1 }, { noAlarm: 'SURGE_BLOCKED' }] },
    { kind: 'sim', run: 4800, dt: 5, actions: [{ t: 600, fault: 'xferStuckClosed', on: true }], expect: [{ alarm: 'XFER_FAIL', from: 600, to: 640 }, { alarm: 'LSHH_SURGE', from: 3600, to: 4800 }, { alarm: 'ESD_TRIPPED', from: 3600, to: 4800 }] },
    { kind: 'sim', set: { wts_Psurge: 2 }, run: 3600, dt: 10, expect: [{ alarm: 'XFER_LOW_DP', from: 300, to: 3600 }] },
  ],
  ex8: [
    { kind: 'page', set: { wts_Twh: 60 }, tol: 0.01, expectState: { 'flow.nodes.2.T': -51.3, 'flow.nodes.2.th': 36.6, 'flow.choke.dTjt': 111.3, 'flow.nodes.0.th': 75.1 },
      expectText: ['WH→ESD: Hydrate risk', 'Choke→Heater: Hydrate risk'], absentText: ['Heater→Sep: Hydrate risk'] },
    { kind: 'page', set: { wts_Twh: 60, wts_bypass: '1' }, expectText: ['Heater→Sep: Hydrate risk', 'Sep→Flare: Hydrate risk'] },
    { kind: 'page', set: {}, tol: 0.01, expectState: { 'flow.nodes.2.T': 68.74, 'flow.nodes.2.th': 36.59 }, absentText: ['Hydrate risk'] },
    { kind: 'sim', set: { wts_Twh: 60 }, run: 120, expect: [{ alarm: 'HYD_choke', from: 0, to: 60 }] },
  ],
  // sim-equip (31 VERSION 1.4.0): SAMPLE_FLOW, DS-101 / T-202 in the rig-up (plan SIM-EQUIPMENT §4.9 anchors)
  ex9: [
    { kind: 'sim', needs: 'desander', rig: { desander: true }, run: 60, dt: 1,
      expect: [{ at: 60, path: 'desander.dP_psi', v: 3.93, tol: 0.01 }, { at: 60, path: 'desander.d50c_um', v: 39.8, tol: 0.01 }, { at: 60, path: 'desander.effClean', v: 0.946, tol: 0.005 },
        { at: 60, path: 'desander.sand.cap_lb', v: 663, tol: 0.005 }, { at: 60, path: 'nodes.esd.P', v: 2999.26, tol: 0.001 }, { at: 60, path: 'nodes.choke.Pin', v: 2995.33, tol: 0.001 }] },
    // flow-back → LAH-103 ≈ 3.5 h at 80 % of the 663 lb accumulator (≈ 530 lb); dump ≈ 17 min (XV-103 opens below 50 psig, the isolation
    // reopens within 75 psi of the desander); bypass → all sand to the bean (HIGH), back in line → OK
    { kind: 'sim', needs: 'desander', rig: { desander: true }, run: 14100, dt: 10,
      actions: [{ t: 0, fault: 'sandFlowback', on: true }, { t: 12700, dump: 'start', ok: true }, { t: 13800, bypass: true }, { t: 13920, bypass: false }],
      expect: [{ alarm: 'DES_LAH', from: 12000, to: 13200 }, { first: { alarm: 'DES_LAH' }, path: 'desander.sand.acc_lb', v: 530, tol: 0.03 },
        { first: { path: 'desander.dump.phase', v: 'flush' }, path: 'desander.dump.Pacc', max: 50 },
        { first: { path: 'desander.dump.phase', v: 'reopen' }, diff: ['desander.Pin', 'desander.dump.Pacc'], max: 75 }, { at: 12900, path: 'desander.dump.phase', v: 'bleed' }, { at: 13300, path: 'desander.dump.phase', v: 'flush' },
        { at: 13700, path: 'desander.dump.phase', v: 'equalise' }, { at: 13790, path: 'desander.dump.phase', v: 'idle' }, { at: 13790, path: 'desander.dump.count', v: 1 },
        { alarm: 'SAND_CHOKE', from: 13800, to: 13920 }, { at: 13910, path: 'sand.choke.band', v: 'high' }, { at: 13910, path: 'desander.dP_psi', v: 0, tol: 0.01 },
        { at: 14100, path: 'sand.choke.band', v: 'ok' }, { noAlarm: 'ESD_TRIPPED' }] },
    // an ESD during a dump holds it; resume refused until the reset, then the interrupted phase continues
    { kind: 'sim', needs: 'desander', rig: { desander: true }, run: 780, dt: 10,
      actions: [{ t: 0, fault: 'sandFlowback', on: true }, { t: 600, dump: 'start', ok: true }, { t: 700, esd: true }, { t: 710, dump: 'resume', ok: false }, { t: 720, resetESD: true }, { t: 760, dump: 'resume', ok: true }],
      expect: [{ at: 710, path: 'desander.dump.phase', v: 'held' }, { at: 780, path: 'desander.dump.phase', v: 'bleed' }] },
  ],
  ex10: [
    // single-compartment T-202 (engine without surge2Comps: the 3.4.1 text these numbers came from)
    { kind: 'sim', needs: 'surge2', unlessFeature: 'surge2Comps', rig: { surge2: true }, run: 660, dt: 1, actions: [{ t: 60, route: 'both' }],
      expect: [{ at: 10, path: 'surge2.inlet', v: false }, { at: 10, path: 'surge2.frac', v: 0, tol: 1e-6 }, { at: 10, path: 'surge2.route', v: 'surge' }, { at: 660, path: 'surge2.route', v: 'both' },
        { at: 240, path: 'surge.pump.on', v: true }, { at: 240, path: 'surge2.share', v: 0, tol: 1e-6 }, { at: 660, path: 'surge.pump.on', v: false }, { at: 660, path: 'surge2.share', v: 0.5, tol: 0.1 }] },
    { kind: 'sim', needs: 'surge2', unlessFeature: 'surge2Comps', rig: { surge2: true }, run: 5200, dt: 5, actions: [{ t: 60, route: 'surge2' }],
      expect: [{ at: 90, path: 'surge.comps.0.inlet', v: false }, { at: 90, path: 'surge2.lsh', v: 0.7 }, { at: 90, path: 'surge2.inlet', v: true }, { at: 4800, path: 'surge2.transfer.on', v: false }, { at: 5100, path: 'surge2.transfer.on', v: true }, { noAlarm: 'ESD_TRIPPED' }] },
    { kind: 'sim', needs: 'surge2', unlessFeature: 'surge2Comps', rig: { surge2: true }, run: 7000, dt: 5, actions: [{ t: 0, route: 'surge2' }, { t: 0, fault: 'xfer2StuckClosed', on: true }],
      expect: [{ alarm: 'LSHH_SURGE2', from: 5800, to: 6800 }, { alarm: 'SURGE_BLOCKED', from: 5800, to: 6800 }, { alarm: 'LSHH_SEP', from: 5800, to: 6900 }, { alarm: 'ESD_TRIPPED', from: 5800, to: 6900 }, { gap: ['LSHH_SURGE2', 'ESD_TRIPPED'], max: 60 }] },
    { kind: 'sim', needs: 'surge2', unlessFeature: 'surge2Comps', rig: { surge2: true }, run: 14500, dt: 10, actions: [{ t: 0, route: 'both' }, { t: 0, fault: 'xfer2StuckClosed', on: true }],
      expect: [{ alarm: 'LSHH_SURGE2', from: 12000, to: 14500 }, { noAlarm: 'ESD_TRIPPED' }, { at: 14500, path: 'surge2.inlet', v: false }] },
    { kind: 'sim', needs: 'surge2', unlessFeature: 'surge2Comps', rig: { surge2: true }, run: 1200, dt: 2, actions: [{ t: 0, route: 'surge2' }, { t: 120, fault: 'bpv2StuckClosed', on: true }],
      expect: [{ alarm: 'PSH_SURGE2', from: 300, to: 500 }, { alarm: 'PSHH_SURGE2', from: 900, to: 1150 }, { alarm: 'ESD_TRIPPED', from: 900, to: 1150 }, { at: 1200, path: 'surge2.inlet', v: false }] },

    // release 3.4.2, two compartments (measured 2026-11-09 on the engine lane's 31 at E3: dual T-202 + LP line; re-checked on the
    // integrated engine — every window below holds unchanged): route T-202 opens XV-202A, then XV-201A closes; A at 80 % about 46 min after the route (2,841 s) →
    // auto-divert to B, suction A, LCV-202 empties A to 25 % (about 3,500 s); LCV-202 stuck on T-202 only: XFER2_FAIL 2,820 s, LAH-202
    // both high 5,605 s, LSHH-202 5,985 s, ESD 6,035 s; on Both: LSHH-202 12,520 s, no ESD; PCV-203 stuck at 120 s: PAH-202 406 s, PSHH-202 / ESD 946 s
    { kind: 'sim', needs: 'surge2', feature: 'surge2Comps', rig: { surge2: true }, run: 660, dt: 1, actions: [{ t: 60, route: 'both' }],
      expect: [{ at: 10, path: 'surge2.comps.0.inlet', v: false }, { at: 10, path: 'surge2.comps.1.inlet', v: false }, { at: 10, path: 'surge2.frac', v: 0, tol: 1e-6 }, { at: 10, path: 'surge2.route', v: 'surge' },
        { at: 660, path: 'surge2.route', v: 'both' }, { at: 660, path: 'surge2.share', v: 0.5, tol: 0.1 }] },
    { kind: 'sim', needs: 'surge2', feature: 'surge2Comps', rig: { surge2: true }, run: 3700, dt: 5, actions: [{ t: 60, route: 'surge2' }],
      expect: [{ at: 90, path: 'surge2.comps.0.inlet', v: true }, { at: 90, path: 'surge2.comps.1.inlet', v: false }, { at: 90, path: 'surge.comps.0.inlet', v: false }, { at: 90, path: 'surge2.suction', v: 'B' },
        { at: 2700, path: 'surge2.transfer.on', v: false }, { at: 2700, path: 'surge2.comps.1.inlet', v: false }, { at: 2950, path: 'surge2.comps.1.inlet', v: true }, { at: 2950, path: 'surge2.comps.0.inlet', v: false },
        { at: 2950, path: 'surge2.suction', v: 'A' }, { at: 2950, path: 'surge2.transfer.on', v: true }, { at: 3650, path: 'surge2.transfer.on', v: false }, { at: 3650, path: 'surge2.comps.0.frac', v: 0.25, tol: 0.08 }, { noAlarm: 'ESD_TRIPPED' }] },
    { kind: 'sim', needs: 'surge2', feature: 'surge2Comps', rig: { surge2: true }, run: 7000, dt: 5, actions: [{ t: 0, route: 'surge2' }, { t: 0, fault: 'xfer2StuckClosed', on: true }],
      expect: [{ alarm: 'LAH_SURGE2_BOTH', from: 5200, to: 6000 }, { alarm: 'LSHH_SURGE2', from: 5600, to: 6400 }, { alarm: 'SURGE_BLOCKED', from: 5600, to: 6400 }, { alarm: 'ESD_TRIPPED', from: 5600, to: 6500 }, { gap: ['LSHH_SURGE2', 'ESD_TRIPPED'], max: 60 }] },
    { kind: 'sim', needs: 'surge2', feature: 'surge2Comps', rig: { surge2: true }, run: 14500, dt: 10, actions: [{ t: 0, route: 'both' }, { t: 0, fault: 'xfer2StuckClosed', on: true }],
      expect: [{ alarm: 'LSHH_SURGE2', from: 12000, to: 14500 }, { noAlarm: 'ESD_TRIPPED' }] },
    { kind: 'sim', needs: 'surge2', feature: 'surge2Comps', rig: { surge2: true }, run: 1200, dt: 2, actions: [{ t: 0, route: 'surge2' }, { t: 120, fault: 'bpv2StuckClosed', on: true }],
      expect: [{ alarm: 'PSH_SURGE2', from: 300, to: 500 }, { alarm: 'PSHH_SURGE2', from: 850, to: 1100 }, { alarm: 'ESD_TRIPPED', from: 850, to: 1100 }, { at: 1200, path: 'surge2.comps.0.inlet', v: false }, { at: 1200, path: 'surge2.comps.1.inlet', v: false }] },
  ],
  // release 3.4.2 FS-5: V-101 out to the surge tank (page check on any engine; the sim checks need the rig chain). Measured 2026-11-09 on the
  // integrated engine: a low-gas well (1 MMscf/d); PCV-201 takes ≈ 0.15 MMscf/d (SEPBY_SURGE_CAP); V-101 out before the cushion → PSHH-201
  // within seconds; cushion started, V-101 out 10 s later: ≈ 26 bbl in T-301 by breakthrough (2,468 s, 41 min), PAH-201 2,650 s, PSHH-201 /
  // ESD 2,715 s (≈ 4 min after breakthrough); V-101 back in at 35 min → no trip
  'FS-5': [
    { kind: 'page', set: { wts_sepByDest: 'surge' }, tol: 0.01, expectState: { 'flow.sim.sepByDest': 'surge', 'flow.sepBy.dest': 'surge', 'flow.sepBy.P0_psig': 25, 'flow.sepBy.choke.regime': 'Critical' } },
    { kind: 'sim', feature: 'rigChain', set: { wts_sepByDest: 'surge', wts_Qg: 1 }, rig: { separator: false }, run: 120, dt: 1,
      expect: [{ alarm: 'SEPBY_SURGE_CAP', from: 0, to: 30 }, { at: 30, path: 'sepBy.dest', v: 'surge' }, { at: 30, path: 'sepBy.gasCap_mmscfd', v: 0.15, tol: 0.03 },
        { alarm: 'PSHH_SURGE', from: 0, to: 60 }, { alarm: 'ESD_TRIPPED', from: 0, to: 60 }] },
    { kind: 'sim', feature: 'rigChain', set: { wts_sepByDest: 'surge', wts_Qg: 1 }, run: 3600, dt: 5, actions: [{ t: 0, cushion: {}, ok: true }, { t: 10, rigup: { separator: false } }],
      expect: [{ at: 2460, path: 'gauge.tanks.0.Vw_bbl', v: 26, tol: 0.05 }, { first: { path: 'cushion.phase', v: 'breakthrough' }, path: 'cushion.tBreak', v: 2468, tol: 0.005 },
        { alarm: 'PSH_SURGE', from: 2400, to: 2700 }, { alarm: 'PSHH_SURGE', from: 2468 + 180, to: 2468 + 330 }, { alarm: 'ESD_TRIPPED', from: 2468 + 180, to: 2468 + 330 },
        { gap: ['PSHH_SURGE', 'ESD_TRIPPED'], max: 10 }] },
    { kind: 'sim', feature: 'rigChain', set: { wts_sepByDest: 'surge', wts_Qg: 1 }, run: 3600, dt: 5,
      actions: [{ t: 0, cushion: {}, ok: true }, { t: 10, rigup: { separator: false } }, { t: 2100, rigup: { separator: true } }], expect: [{ noAlarm: 'PSHH_SURGE' }, { noAlarm: 'ESD_TRIPPED' }] },
  ],
  'FS-3': [
    { kind: 'sim', needs: 'desander', rig: { desander: true }, run: 30, expect: [{ at: 30, path: 'desander.sithp_psi', v: 3600 }, { at: 30, path: 'desander.sithpEst', v: true }, { at: 30, path: 'desander.ratingOK', v: true }, { noAlarm: 'DES_RATING' }] },
    { kind: 'sim', needs: 'desander', rig: { desander: true }, cfg: { desander: { rating_psi: 5000, sithp_psig: 6000 } }, run: 30, expect: [{ alarm: 'DES_RATING', from: 0, to: 30 }, { at: 30, path: 'desander.ratingOK', v: false }] },
    // 10 lb/1000 bbl: steel-equivalent erosion WARN without DS-101, OK with it, ratio ≈ 68
    { kind: 'sim', needs: 'desander', cfg: { sand: { pptb: 10 } }, run: 600, dt: 5, expect: [{ at: 600, path: 'sand.choke.band', v: 'warn' }, { at: 600, path: 'sand.choke.erosion_mild', v: 4.36, tol: 0.01 }] },
    { kind: 'sim', needs: 'desander', rig: { desander: true }, cfg: { sand: { pptb: 10 } }, run: 600, dt: 5, expect: [{ at: 600, path: 'sand.choke.band', v: 'ok' }, { at: 600, path: 'sand.choke.erosion_mild', v: 0.0650, tol: 0.02 }] },
  ],
  // 31 v1.5.0: CK-102 staging (SIM-FOLLOWUP ANCHORS_CK2; the steady walk publishes flow.ck2 whatever the rig-up)
  ex11: [
    { kind: 'page', set: { wts_bean2: 48 }, tol: 0.002, expectState: { 'flow.ck2.Pin': 1135.1, 'flow.ck2.ck1.ratio': 0.3816, 'flow.ck2.ck1.regime': 'Critical', 'flow.ck2.limiter': 'CK-101',
      'flow.ck2.QmaxMMscfd': 10.71, 'flow.ck2.sit_psig': 3600, 'flow.ck2.sitEst': true, 'flow.ck2.ratingOK': false } },
    { kind: 'page', set: { wts_bean2: 32 }, tol: 0.002, expectState: { 'flow.ck2.limiter': 'CK-102', 'flow.ck2.flowLimited': true, 'flow.ck2.QmaxMMscfd': 8.92, 'flow.ck2.Pin': 2401.6, 'flow.ck2.ck1.regime': 'Subcritical' } },
    // review round: the page states the pair at its capacity, so page and live agree (about 2,400 psig); PAH-102 from 44/64 down
    { kind: 'page', set: { wts_bean2: 44 }, tol: 0.002, expectState: { 'flow.ck2.Pin': 1357.9, 'flow.ck2.flowLimited': false } },
    { kind: 'page', set: { wts_bean2: 64 }, tol: 0.002, expectState: { 'flow.ck2.Pin': 634.4, 'flow.ck2.ck1.regime': 'Critical' } },
    { kind: 'sim', needs: 'heaterChoke', set: { wts_bean2: 32 }, rig: { heaterChoke: true }, run: 120, expect: [{ alarm: 'CHOKE2_LIMIT', from: 0, to: 30 }, { alarm: 'CK1_SUBCRIT', from: 0, to: 30 }, { noAlarm: 'CHOKE_LIMIT' },
      { at: 120, path: 'nodes.heaterChoke.Pin', v: 2400, tol: 0.01 }] },
    { kind: 'sim', needs: 'heaterChoke', set: { wts_bean2: 44 }, rig: { heaterChoke: true }, run: 60, expect: [{ alarm: 'PAH_CK2', from: 0, to: 30 }] },
    { kind: 'sim', needs: 'heaterChoke', set: { wts_bean2: 48 }, rig: { heaterChoke: true }, run: 60, expect: [{ noAlarm: 'PAH_CK2' }] },
  ],
  // FS-1 (a)–(d) of plan §6.2; (e) is FS-2's default-spread check. Since 31 v1.5.0 the main text is the cushion scenario (afterSim, the
  // last three sim checks); the older checks stand for the short 'today' note (the order of the pressure changes) and the legacy V-101-out path.
  'FS-1': [
    { kind: 'page', set: mix(FS1, { wts_Psurge: 25 }), tol: 0.01, expectState: { 'flow.choke.Pout': 20.5, 'flow.choke.regime': 'Critical', 'flow.choke.flowLimited': false,
      'flow.choke.QmaxMMscfd': 1.78, 'flow.choke.ratio': 0.0684, 'flow.sim.surgeP_psig': 5 }, expectText: ['Surge tank pressure too close to separator pressure — liquids cannot dump'] },
    { kind: 'page', set: FS1, tol: 0.01, expectState: { 'flow.choke.Pout': 20.5, 'flow.warnings.length': 0 }, absentText: ['Surge tank pressure too close'] },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 60 }), tol: 0.02, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 0.25 } },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 100 }), tol: 0.02, expectState: { 'flow.choke.flowLimited': false, 'flow.choke.QmaxMMscfd': 0.387 } },
    { kind: 'page', set: mix(FS1, { wts_Pwh: 2000, wts_Qg: 5, wts_Qo: 500, wts_Qw: 300 }), tol: 0.01,
      expectState: { 'flow.choke.Pout': 24.1, 'flow.choke.QmaxMMscfd': 7.21, 'flow.choke.regime': 'Critical', 'flow.warnings.length': 0 } },
    // the bypass rate limit quoted after the steps: breakthrough values at 10 MMscf/d
    { kind: 'page', set: mix(FS1, { wts_Pwh: 2000, wts_Qg: 10, wts_Qo: 500, wts_Qw: 300 }), tol: 0.01, expectState: { 'flow.choke.flowLimited': true, 'flow.choke.QmaxMMscfd': 7.21 },
      expectText: ['Choke is flow-limited — bean 32/64" at Cd=0.85 can only pass 7.21 MMSCFD', 'Heater→Sep: Velocity 291 ft/s EXCEEDS erosional limit 259 ft/s'] },
    // FS-1 steps 1–8 in the written order on the live sim (review blocker: the old order tripped PSHH-101 / PSHH-201): no ESD,
    // ≈ 150 bbl to the burner in 90 min with the choke outlet ≈ 10.5 psig, and V-101 back in at 150 psig after the restore step
    { kind: 'sim', run: 12000, dt: 2,
      actions: [{ t: 300, form: { wts_Psurge: 15 } }, { t: 900, form: { wts_Psurge: 5 } }, { t: 1500, form: { wts_Psep: 15 } }, { t: 2100, rigup: { separator: false } },
        { t: 2400, form: { wts_Qg: 0.3, wts_Qo: 0, wts_Qw: 2400, wts_Pwh: 500, wts_bean: 32 } }, { t: 7800, form: { wts_Qg: 5, wts_Qo: 500, wts_Qw: 300, wts_Pwh: 2000 } },
        { t: 9000, form: { wts_Psep: 150, wts_Psurge: 25 } }, { t: 10200, rigup: { separator: true } }],
      expect: [{ noAlarm: 'ESD_TRIPPED' }, { noAlarm: 'PSHH_SEP' }, { noAlarm: 'PSHH_SURGE' }, { at: 890, path: 'surge.P', v: 15, tol: 0.2 }, { at: 1490, path: 'surge.P', v: 5, tol: 0.3 },
        { at: 2090, path: 'sep.P', v: 15, tol: 0.1 }, { at: 3000, path: 'nodes.choke.P', v: 11.5, tol: 0.05 }, { at: 3000, path: 'rigup.separator', v: false },
        { at: 7800, path: 'cum.liquidToFlareWater_bbl', v: 150, tol: 0.05 }, { at: 12000, path: 'sep.P', v: 150, tol: 0.02 }, { at: 12000, path: 'rigup.separator', v: true }] },
    // the four things the warning names each trip the ESD
    { kind: 'sim', run: 600, dt: 2, actions: [{ t: 60, form: { wts_Qg: 0.3, wts_Qo: 0, wts_Qw: 2400, wts_Pwh: 500 } }], expect: [{ alarm: 'PSHH_SEP', from: 60, to: 120 }, { alarm: 'ESD_TRIPPED', from: 60, to: 120 }] },
    { kind: 'sim', run: 600, dt: 2, actions: [{ t: 60, rigup: { separator: false } }, { t: 180, form: { wts_Psep: 15, wts_Psurge: 5 } }],
      expect: [{ alarm: 'PSHH_SEP', from: 180, to: 300 }, { alarm: 'ESD_TRIPPED', from: 180, to: 300 }] },
    { kind: 'sim', run: 600, dt: 2, actions: [{ t: 60, form: { wts_Psep: 15 } }], expect: [{ alarm: 'PSHH_SURGE', from: 60, to: 200 }, { alarm: 'ESD_TRIPPED', from: 60, to: 200 }] },
    { kind: 'sim', run: 600, dt: 2, actions: [{ t: 60, form: { wts_Psurge: 5 } }], expect: [{ alarm: 'PSHH_SURGE', from: 60, to: 200 }, { alarm: 'ESD_TRIPPED', from: 60, to: 200 }] },
    // v1.5.0: the V-101-out back pressure uses the whole-stream line loss (11.5 psig here, 10.5 with the separator-gas loss of v3.3.1)
    { kind: 'sim', set: FS1, rig: { separator: false }, run: 900, dt: 5, expect: [{ at: 900, path: 'nodes.choke.P', v: 11.5, tol: 0.03 }, { at: 900, path: 'rigup.flare', v: true }] },
    { kind: 'sim', run: 900, dt: 5, rig: { separator: false }, expect: [{ at: 900, path: 'nodes.choke.P', v: 14.3, tol: 0.03 }] },
    // the cushion to the burner at the defaults (ANCHORS_CUSH): CUSH_BURNER at once, WHP target ≈ 1,700 at the start (the gauge bottoms ≈ 1,840
    // 205 s after the start), choke outlet ≈ 5 psig while unloading, breakthrough 2,468 s (41 min) after the start, the WHP peak ≈ 3,460 at
    // 41.75 min, done ≈ 3.2 h after the start, 50 bbl to the burner; at the full rate the choke outlet ≈ 35 psig, seg 4 / 5 above the erosional velocity (the FI VEL_* alarms; not while the column unloads)
    { kind: 'sim', needs: 'heaterChoke', set: { wts_sepByDest: 'flare' }, run: 12300, dt: 5, rig: { separator: false }, actions: [{ t: 300, cushion: {}, ok: true }],
      expect: [{ alarm: 'CUSH_BURNER', from: 300, to: 320 }, { noAlarm: 'ESD_TRIPPED' }, { noAlarm: 'CUSH_LIMIT' }, { noAlarm: 'CUSH_NOLIFT' },
        { first: { path: 'cushion.phase', v: 'unloading' }, path: 'cushion.WHPtgt_psig', v: 1700, tol: 0.01 }, { at: 1200, path: 'nodes.choke.P', v: 5.1, tol: 0.05 },
        { first: { path: 'cushion.phase', v: 'breakthrough' }, path: 'cushion.tBreak', v: 300 + 2468, tol: 0.005 }, { at: 300 + 205, path: 'nodes.wellhead.P', v: 1840, tol: 0.01 },
        { at: 300 + 2505, path: 'nodes.wellhead.P', v: 3460, tol: 0.01 }, { at: 300 + 5400, path: 'nodes.choke.P', v: 35, tol: 0.05 }, { at: 300 + 1200, path: 'segs.4.vSt', v: 'OK' }, { at: 300 + 5400, path: 'segs.3.vSt', v: 'EXCEED' }, { at: 300 + 5400, path: 'segs.4.vSt', v: 'EXCEED' },
        { first: { path: 'cushion.phase', v: 'done' }, path: 't', v: 300 + 3.2 * 3600, tol: 0.04 }, { at: 12300, path: 'cushion.recovered_bbl', v: 50, tol: 0.002 },
        { at: 12300, path: 'cushion.out.flare', v: 50, tol: 0.002 }] },
    // through V-101: Start warns, CUSH_DUMP (≈ 790 bbl/d dump), LAHH-101 within 5 minutes, carry-over
    { kind: 'sim', needs: 'heaterChoke', set: { wts_sepByDest: 'flare' }, run: 1200, dt: 5, actions: [{ t: 300, cushion: {}, ok: true, warn: 'V-101 water dump passes 788 bbl/d' }],
      expect: [{ alarm: 'CUSH_DUMP', from: 300, to: 330 }, { alarm: 'ISHH_SEP', from: 300, to: 600 }, { alarm: 'CARRYOVER', from: 300, to: 900 }] },
    // the bean limits the liquid: 12/64 at 1 MMscf/d → CUSH_LIMIT, about 1,200 bbl/d
    { kind: 'sim', needs: 'heaterChoke', set: { wts_bean: 12, wts_Qg: 1 }, rig: { separator: false }, run: 600, dt: 5, actions: [{ t: 300, cushion: {}, ok: true }],
      expect: [{ alarm: 'CUSH_LIMIT', from: 300, to: 400 }, { at: 600, path: 'cushion.q_bpd', v: 1200, tol: 0.02 }] },
  ],
  'FS-2': [
    { kind: 'page', set: {}, tol: 0.005, expectState: { 'flow.choke.Pout': 157.7, 'flow.choke.ratio': 0.0572, 'flow.choke.regime': 'Critical' } },
    { kind: 'sim', run: 300, rig: { flare: false, surge: false, gauge: false },
      expect: [{ at: 300, path: 'sep.pshh', v: 180 }, { at: 300, path: 'sep.psh', v: 165 }, { at: 300, path: 'sep.psl', v: 120 }, { at: 300, path: 'sep.mawp', v: 1440 }, { at: 300, path: 'rigup.flare', v: false }] },
    { kind: 'sim', run: 10, rig: { separator: false, flare: false }, expect: [{ at: 10, path: 'rigup.flare', v: true }] },
    // 31 v1.5.0 (afterSim): V-101 out to a production line at 300 psig, FS-401 out too (relief to vent)
    { kind: 'page', set: { wts_sepByDest: 'line', wts_sepByP: 300 }, tol: 0.005, expectState: { 'flow.sepBy.P0_psig': 300, 'flow.sepBy.choke.Pout': 308, 'flow.sepBy.choke.ratio': 0.107,
      'flow.sepBy.choke.regime': 'Critical', 'flow.sepBy.warnings.length': 0 } },
    { kind: 'page', set: { wts_Pwh: 1000, wts_sepByDest: 'line', wts_sepByP: 600 }, tol: 0.01, expectState: { 'flow.sepBy.choke.regime': 'Subcritical', 'flow.sepBy.choke.ratio': 0.61 } },
    { kind: 'sim', needs: 'heaterChoke', set: { wts_sepByDest: 'line', wts_sepByP: 300 }, rig: { separator: false, flare: false }, run: 600, dt: 5,
      expect: [{ at: 600, path: 'rigup.flare', v: false }, { at: 600, path: 'sepBy.vent', v: true }, { at: 600, path: 'sepBy.P0_psig', v: 300 }, { at: 600, path: 'nodes.choke.P', v: 308, tol: 0.005 },
        { noAlarm: 'ESD_TRIPPED' }, { noAlarm: 'PSHH_SEPBY' }] },
  ],
  'FS-4': [
    { kind: 'page', set: { wts_Twh: 60, wts_bypass: '1' }, tol: 0.01, expectState: { 'flow.nodes.2.T': -51.3, 'flow.nodes.2.th': 36.5 },
      expectText: ['WH→ESD: Hydrate risk', 'Heater→Sep: Hydrate risk', 'Sep→Flare: Hydrate risk'] },
    { kind: 'page', set: { wts_Twh: 60 }, expectText: ['ESD→Choke: Hydrate risk', 'Choke→Heater: Hydrate risk'], absentText: ['Heater→Sep: Hydrate risk'] },
    { kind: 'page', set: {}, tol: 0.01, expectState: { 'flow.nodes.2.T': 68.74 }, absentText: ['Hydrate risk'] },
  ],
};
const NO_NUMBERS = { ex3: 'reuses FS-1 by reference; FS-1 carries the checks' };

// ── helpers ──
const txt = (e) => String((e && e.textContent) || '').replace(/\s+/g, ' ').trim();
const A = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const getPath = (o, p) => String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const near = (a, b, tol) => (typeof b === 'number' ? typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 0.005 : tol) * Math.max(1, Math.abs(b)) : a === b);
const fail = (assert, list, what) => assert.ok(!list.length, what + ':\n  ' + list.slice(0, 40).join('\n  ') + (list.length > 40 ? '\n  … ' + (list.length - 40) + ' more' : ''));
const readSrc = (f) => fs.readFileSync(path.join(BUILD, f), 'utf8');
function strings(v, p, cb) {
  if (typeof v === 'string') { cb(v, p); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => strings(x, p + '[' + i + ']', cb)); return; }
  if (v && typeof v === 'object') Object.keys(v).forEach((k) => { if (k !== 'form' && k !== '_group') strings(v[k], p + '.' + k, cb); });
}
// release 3.4.2: feature / unlessFeature gate a check on WTS_sim.features (surge2Comps, lpFlare, rigChain), so the checks of the
// 3.4.1 engine and of the 3.4.2 engine sit side by side while the lanes are apart
const hasItem = (V, c) => (!c.needs || V.optional.has(c.needs)) && (!c.feature || !!V.features[c.feature]) && (!c.unlessFeature || !V.features[c.unlessFeature]);
const EQUIP = ['desander', 'surge2'];
// The simcourse factory built against a stand-in engine that has DS-101 and T-202 (the sim-equip content), on any engine.
function equipContent(app) {
  const W = app.win, real = W.WTS_sim, f = A(W.WTS_helpContent.factories).filter((x) => x.group === 'simcourse')[0];
  try { W.WTS_sim = Object.assign(Object.create(real), { RIG_OPTIONAL: app.toWin(EQUIP) }); return f.build(); } finally { W.WTS_sim = real; }
}
function content(app) { const C = app.win.WTS_help.load(); return { C, course: A(C.course).filter((x) => x._group === 'simcourse'), scenarios: A(C.scenarios).filter((x) => x._group === 'simcourse') }; }
function openWts(app, set) {
  if (!Object.prototype.hasOwnProperty.call(set || {}, 'wts_sepByDest')) set = Object.assign({ wts_sepByDest: 'flare' }, set || {});   // 3.4.2: page default 'surge'
  app.hook.nav('home');
  app.storage.removeItem('wts_page_wts'); app.storage.removeItem('wts_wts');
  app.hook.nav('wts');
  app.flush(300);
  Object.keys(set || {}).forEach((id) => {
    const el = app.el(id);
    if (!el) throw new Error('no #' + id + ' on the wts page');
    if (String(el.localName).toLowerCase() === 'select') app.select(el, String(set[id]));
    else { app.input(el, String(set[id])); app.change(el, String(set[id])); }
  });
  app.win.calcWTS();
  app.flush(300);
}
function pageCheck(app, where, ck) {
  const out = [];
  try { openWts(app, ck.set); } catch (e) { return [where + ': ' + e.message]; }
  const W = app.win;
  Object.keys(ck.expectState || {}).forEach((k) => { const v = getPath(W.WTS_state, k); if (!near(v, ck.expectState[k], ck.tol)) out.push(where + ': WTS_state.' + k + ' = ' + v + ', text says ' + ck.expectState[k]); });
  const body = txt(app.el('pgBody'));
  A(ck.expectText).forEach((t) => { if (body.indexOf(t) === -1) out.push(where + ': page does not show "' + t + '"'); });
  A(ck.absentText).forEach((t) => { if (body.indexOf(t) !== -1) out.push(where + ': page still shows "' + t + '"'); });
  return out;
}
const activeIds = (st) => A(st.alarms).filter((a) => a && a.active !== false).map((a) => a.id);
// sim check: flow from calcWTS with `set` (else SAMPLE_FLOW), noise off, seed 7; actions at sim times; expectations:
//   { alarm, from, to } first raise in [from, to] · { noAlarm } never active · { at, path, v, tol } value at a time ·
//   actions: { t, fault, on } · { t, esd } · { t, resetESD: ok, blocking } · { t, sp } (separator set point) · { t, valve: [eq, idx, open] } ·
//   { t, form: { wts_id: v } } (typed into the form as a user does: the page recalculates and the sim gets the new flow; form values
//   accumulate over the run, on top of `set`) · { t, rigup: { key: on } }
//   { batch: n, from, to } the n-th gauge batch is listed (closed and settled) in [from, to] · { gap: [a, b], max } b first raised
//   0…max s after a · sim-equip: { t, dump: 'start'|'resume'|'abort', ok } · { t, bypass } (DS-101) · { t, route } (T-202) ·
//   v1.5.0: { t, cushion: {V, SG, q, cap, depth} | 'stop', ok, warn } (startCushion / stopCushion) ·
//   cfg (setConfig at create) · needs: a rig-up item the engine must have (WTS_sim.RIG_OPTIONAL), else the check is skipped ·
//   { first: { alarm } | { path, v }, path, v, tol } or { …, max } (value ≤ max) or { first, diff: [a, b], max } (|a − b| ≤ max): read
//   once, on the first step where the condition holds
function simCheck(app, where, ck) {
  const out = [], W = app.win, S = W.WTS_sim;
  if (!S) return [where + ': WTS_sim missing'];
  let flow = S.SAMPLE_FLOW;
  if (ck.set && Object.keys(ck.set).length) { openWts(app, ck.set); flow = JSON.parse(JSON.stringify(W.WTS_state.flow)); }
  const s = S.create(app.toWin(flow), app.toWin({ seed: 7, config: Object.assign({ noise: { on: false } }, JSON.parse(JSON.stringify(ck.cfg || {}))) }));
  if (ck.rig) s.setRigup(app.toWin(ck.rig));
  const dt = ck.dt || 2, acts = A(ck.actions).map((a) => Object.assign({ done: false }, a)), first = {}, ats = A(ck.expect).filter((e) => e.at != null).map((e) => Object.assign({ done: false }, e));
  const whens = A(ck.expect).filter((e) => e.first).map((e) => Object.assign({ done: false }, e));
  let batchT = {}, t = 0, seq = 1;
  const form = Object.assign({}, ck.set || {});
  const doAct = (a) => {
    if (a.form) { Object.assign(form, a.form); openWts(app, form); const f2 = JSON.parse(JSON.stringify(W.WTS_state.flow)); f2.seq = 1000 + (++seq); s.setFlow(app.toWin(f2)); }
    if (a.rigup) s.setRigup(app.toWin(a.rigup));
    if (a.fault) s.setFault(a.fault, a.on !== false);
    if (a.esd) s.tripESD('manual');
    if (a.valve) s.setValve(a.valve[0], a.valve[1], !!a.valve[2]);
    if (a.bypass != null) s.setDesander(app.toWin({ bypass: !!a.bypass }));
    if (a.route) { const r = s.setSurgeRoute(a.route); if (!r || !r.ok) out.push(where + ': route ' + a.route + ' at ' + a.t + ' s refused (' + (r && r.msg) + ')'); }
    if (a.cushion) {
      const r = a.cushion === 'stop' ? { ok: s.stopCushion() } : s.startCushion(app.toWin(a.cushion));
      if (a.ok != null && !!(r && r.ok) !== !!a.ok) out.push(where + ': cushion ' + JSON.stringify(a.cushion) + ' at ' + a.t + ' s gave ok=' + (r && r.ok) + ', text says ' + a.ok);
      if (a.warn && String((r && r.warn) || '').indexOf(a.warn) === -1) out.push(where + ': cushion start warning "' + (r && r.warn) + '", text says "' + a.warn + '"');
    }
    if (a.dump) { const r = s.dumpDesander(a.dump); if (!!(r && r.ok) !== !!a.ok) out.push(where + ': dump ' + a.dump + ' at ' + a.t + ' s gave ok=' + (r && r.ok) + ', text says ' + a.ok); }
    if (a.sp != null) { const f2 = JSON.parse(JSON.stringify(flow)); f2.separatorPressure = a.sp; f2.inputs.Psep = a.sp; f2.seq = (f2.seq || 1) + 1; s.setFlow(app.toWin(f2)); }
    if (a.resetESD != null) {
      const r = s.resetESD();
      if (!!r.ok !== !!a.resetESD) out.push(where + ': Reset ESD at ' + a.t + ' s gave ok=' + r.ok + ', text says ' + a.resetESD);
      if (a.blocking && A(r.blocking).indexOf(a.blocking) === -1) out.push(where + ': Reset ESD at ' + a.t + ' s not blocked by ' + a.blocking + ' (' + r.blocking + ')');
    }
  };
  const look = () => {
    const st = s.getState();
    activeIds(st).forEach((id) => { if (first[id] == null) first[id] = st.t; });
    A(st.gauge && st.gauge.batches).forEach((b, i) => { if (batchT[i + 1] == null) batchT[i + 1] = st.t; });
    ats.forEach((e) => {
      if (e.done || st.t < e.at - 1e-6) return;
      e.done = true;
      const v = getPath(st, e.path);
      if (!near(v, e.v, e.tol)) out.push(where + ': at ' + e.at + ' s ' + e.path + ' = ' + v + ', text says ' + e.v);
    });
    const ids = activeIds(st);
    whens.forEach((e) => {
      if (e.done || !(e.first.alarm ? ids.indexOf(e.first.alarm) !== -1 : near(getPath(st, e.first.path), e.first.v))) return;
      e.done = true;
      const what = (e.diff ? '|' + e.diff.join(' − ') + '|' : e.path) + ' at ' + (e.first.alarm || e.first.path + ' = ' + e.first.v) + ' (' + st.t + ' s)';
      const v = e.diff ? Math.abs(getPath(st, e.diff[0]) - getPath(st, e.diff[1])) : getPath(st, e.path);
      if (e.max != null ? !(v <= e.max) : !near(v, e.v, e.tol)) out.push(where + ': ' + what + ' = ' + v + ', text says ' + (e.max != null ? '≤ ' + e.max : e.v));
    });
  };
  while (t < ck.run - 1e-9) {
    acts.forEach((a) => { if (!a.done && a.t <= t + 1e-9) { a.done = true; doAct(a); } });
    s.advance(dt); t += dt;
    look();
  }
  A(ck.expect).forEach((e) => {
    if (e.alarm) { const f = first[e.alarm]; if (f == null || f < e.from || f > e.to) out.push(where + ': alarm ' + e.alarm + ' first at ' + f + ' s, text needs ' + e.from + '–' + e.to + ' s'); }
    if (e.noAlarm && first[e.noAlarm] != null) out.push(where + ': ' + e.noAlarm + ' raised at ' + first[e.noAlarm] + ' s, text says it does not');
    if (e.gap) { const a = first[e.gap[0]], b = first[e.gap[1]]; if (a == null || b == null || b < a || b - a > e.max) out.push(where + ': ' + e.gap[1] + ' ' + (b == null || a == null ? 'missing' : (b - a) + ' s') + ' after ' + e.gap[0] + ', text needs 0–' + e.max + ' s'); }
    if (e.batch) { const f = batchT[e.batch]; if (f == null || f < e.from || f > e.to) out.push(where + ': batch ' + e.batch + ' closed at ' + f + ' s, text needs ' + e.from + '–' + e.to + ' s'); }
  });
  ats.forEach((e) => { if (!e.done) out.push(where + ': run ended before ' + e.at + ' s'); });
  whens.forEach((e) => { if (!e.done) out.push(where + ': ' + (e.first.alarm || e.first.path + ' = ' + e.first.v) + ' never reached'); });
  if (typeof s.dispose === 'function') s.dispose();
  return out;
}
// Engine vocabulary: tags in WTS_sim.TAGS and anywhere in the engine source; alarm ids from aDef('<ID>', …).
function engineVocab(app) {
  const S = app.win.WTS_sim, src = readSrc('31-wts-sim.js');
  const tags = new Set(Object.keys(S.TAGS).map((k) => S.TAGS[k]));
  (src.match(/\b[A-Z]{1,5}-\d{3}[A-Z]?\b/g) || []).forEach((t) => tags.add(t));
  const alarms = new Set();
  // aDef('<ID>', …) and (3.4.2 engine, cached lookups) aDefC(<n>, '<ID>', …)
  (src.match(/aDefC?\((?:\d+,\s*)?'([A-Z0-9_]+)/g) || []).forEach((m) => alarms.add(m.replace(/^aDefC?\((?:\d+,\s*)?'/, '')));
  if (/aDef\('HYD_' \+/.test(src)) ['wellhead', 'esd', 'choke', 'heater', 'separator'].forEach((n) => alarms.add('HYD_' + n));
  // Scenarios menu labels as 38 builds them (faultList): its own descriptive label for the ids it knows, else the engine label
  const local = new Map(), m = /var FAULTS = \[([\s\S]*?)\]\];/.exec(readSrc('38-wts-live.js'));
  ((m && m[1] + ']') || '').replace(/\['([A-Za-z0-9]+)', '([^']+)'\]/g, (x, id, l) => { local.set(id, l); return x; });
  const faults = new Map(A(S.FAULTS).map((f) => [local.get(f.id) || f.label, f.id]));
  // release 3.4.2 names, accepted on an engine that predates them (the host lane's help text is written to the 3.4.2 contract)
  const F = S.features || {};
  if (!F.surge2Comps) ['XV-202A', 'XV-202B', 'T-202A', 'T-202B'].forEach((t) => tags.add(t));
  if (!F.lpFlare) { tags.add('FT-201'); ['VEL_LP', 'PAH_LP', 'FT201_LOWCUT'].forEach((a) => alarms.add(a)); }
  if (!F.surge2Comps) alarms.add('LAH_SURGE2_BOTH');
  if (!F.rigChain) ['SEPBY_SURGE_CAP', 'SEPBY_VENT'].forEach((a) => alarms.add(a));
  return { tags, alarms, faults, faultIds: new Set(A(S.FAULTS).map((f) => f.id)), rig: new Set(A(S.RIG_KEYS)), optional: new Set(A(S.RIG_OPTIONAL)), features: F };
}
const shown = (F, x) => !!(x && x.feature && F && F[x.feature]);   // afterSim is the variant shown (and so checked) once the feature is in
const TAG_RE = /\b[A-Z]{1,5}-\d{3}[A-Z]?\b/g, ALARM_RE = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/g;
function refIssues(items, V) {
  const out = [];
  items.forEach((x) => strings(x, x.id, (s, p) => {
    if (/\.afterSim/.test(p) && !shown(V.features, x)) return;   // a variant for a feature the engine does not have (WTS_sim.features)
    (s.match(TAG_RE) || []).forEach((t) => { if (!V.tags.has(t)) out.push(p + ': tag ' + t + ' is not in the engine'); });
    (s.match(ALARM_RE) || []).forEach((t) => { if (!V.alarms.has(t)) out.push(p + ': alarm id ' + t + ' is not in the engine'); });
    (s.match(/\*\*Scenarios → ([^*]+)\*\*/g) || []).forEach((b) => { const l = b.slice(14, -2); if (!V.faults.has(l)) out.push(p + ': fault "' + l + '" is not in WTS_sim.FAULTS'); });
  }));
  return out;
}
// String literals of a JS source (quotes and template text; comments, identifiers and regex-free code skipped).
function literals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1, t = '';
      while (j < n && src[j] !== c && !(c !== '`' && src[j] === '\n')) { if (src[j] === '\\') { t += src[j + 1] || ''; j += 2; } else t += src[j++]; }
      out.push(t);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}
// Bold phrases: visible text on the wts page (form, HUD, toolbar), or a string literal of the HMI / engine source (button,
// row and menu labels; never a comment or a variable name), or a speed label; a menu path "A → B" checks each part.
// afterSim is skipped (feature-gated).
function boldVocab(app) {
  const S = app.win.WTS_sim;
  return [txt(app.el('pgBody')), txt(app.el('pgTitle'))].concat(literals(readSrc('38-wts-live.js')), literals(readSrc('31-wts-sim.js')),
    A(S.DEFAULTS.speeds).map((v) => '×' + v)).join(' | ').replace(/&amp;/g, '&').toLowerCase();
}
function boldIssues(app, items) {
  openWts(app, {});
  const vocab = boldVocab(app);
  const out = [];
  const F = app.win.WTS_sim && app.win.WTS_sim.features;
  items.forEach((x) => strings(x, x.id, (s, p) => {
    if (/\.afterSim/.test(p) && !shown(F, x)) return;
    (s.match(/\*\*([^*]+)\*\*/g) || []).forEach((b) => {
      b.slice(2, -2).split('→').map((q) => q.trim().toLowerCase()).forEach((q) => { if (q && vocab.indexOf(q) === -1) out.push(p + ': bold "' + q + '" is not on the page or in the simulator'); });
    });
  }));
  return out;
}
function shapeIssues(app, course, scenarios) {
  const out = [], size = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  const ids = new Set(Array.from(app.el('pgBody').querySelectorAll('input[id^="wts_"], select[id^="wts_"]')).map((e) => e.id));
  if (!course.length) out.push('no exercises');
  course.forEach((x, i) => {
    const w = 'course[' + (x.id || i) + ']';
    if (x.id !== 'ex' + (i + 1)) out.push(w + ': id should be ex' + (i + 1) + ' (exercises in order)');
    ['title', 'goal'].forEach((k) => { if (!x[k]) out.push(w + ': ' + k + ' missing'); });
    ['setup', 'steps', 'observe', 'questions', 'answers', 'keywords'].forEach((k) => { if (!A(x[k]).length) out.push(w + ': ' + k + ' missing'); });
    const t = x.trainer || {};
    ['duration', 'fault', 'good'].forEach((k) => { if (!t[k]) out.push(w + ': trainer.' + k + ' missing'); });
    if (!A(t.mistakes).length) out.push(w + ': trainer.mistakes missing');
    if (A(t.debrief).length < 3 || A(t.debrief).length > 5) out.push(w + ': trainer.debrief needs 3–5 questions');
    if (!x.form || typeof x.form !== 'object') out.push(w + ': form (set-up values) missing');
    else Object.keys(x.form).forEach((k) => { if (!/^wts_/.test(k) || !ids.has(k)) out.push(w + ': form id ' + k + ' is not a wts_* input on the page'); });
    if (size(x) > 4096) out.push(w + ': ' + size(x) + ' bytes, over 4 kB');
  });
  scenarios.forEach((x, i) => {
    const w = 'scenarios[' + (x.id || i) + ']';
    if (!/^FS-\d+$/.test(String(x.id))) out.push(w + ': id FS-n');
    if (!x.title || !A(x.today).length || !A(x.keywords).length) out.push(w + ': title, today and keywords required');
    if (size(x) > 5120) out.push(w + ': ' + size(x) + ' bytes, over 5 kB');
  });
  ['FS-1', 'FS-2'].forEach((id) => {
    const x = scenarios.filter((s) => s.id === id)[0];
    if (!x) { out.push(id + ' missing'); return; }
    const intro = A(x.intro);
    if (!(intro[0] && intro[0].h === 'Which pressure goes where')) out.push(id + ': must open with "Which pressure goes where"');
    const tab = intro.filter((b) => b && b.table && /pressure you have/i.test(A(b.table.head).join(' ')))[0];
    if (!tab) out.push(id + ': the which-pressure table is missing');
    else {
      const flat = A(tab.table.rows).map((r) => r.join(' | ')).join(' / ');
      ['Wellhead Pressure', 'Operating Pressure', 'Surge Tank Pressure', 'V-101 out', 'V-101 in only'].forEach((k) => { if (flat.indexOf(k) === -1) out.push(id + ': the table does not mention ' + k); });
    }
    if (x.feature !== 'bypassDest' || !A(x.afterSim).length) out.push(id + ': needs both variants (today, afterSim) with feature bypassDest');
  });
  const ex3 = course.filter((x) => x.id === 'ex3')[0];
  if (ex3 && JSON.stringify(ex3).indexOf('[[fs#FS-1') === -1) out.push('ex3 must reuse FS-1 by reference');
  course.concat(scenarios).forEach((x) => { if (!CHECKS[x.id]) out.push(x.id + ': no CHECKS entry in help-course.test.js'); else if (!CHECKS[x.id].length && !NO_NUMBERS[x.id]) out.push(x.id + ': empty CHECKS without a NO_NUMBERS reason'); });
  return out;
}
function simCheckShape(V) {
  const out = [];
  Object.keys(CHECKS).forEach((id) => CHECKS[id].filter((c) => c.kind === 'sim').forEach((c, i) => {
    const w = id + ' sim[' + i + ']';
    if (!hasItem(V, c)) return;   // sim-equip check on an engine without that item
    A(c.actions).forEach((a) => { if (a.fault && !V.faultIds.has(a.fault)) out.push(w + ': fault ' + a.fault + ' not in WTS_sim.FAULTS'); });
    A(c.expect).forEach((e) => { [e.alarm, e.noAlarm, e.first && e.first.alarm].concat(A(e.gap)).filter(Boolean).forEach((a) => { if (!V.alarms.has(a)) out.push(w + ': alarm ' + a + ' not in the engine'); }); });
    Object.keys(c.rig || {}).forEach((k) => { if (!V.rig.has(k)) out.push(w + ': rig-up key ' + k + ' not in WTS_sim.RIG_KEYS'); });
    A(c.actions).forEach((a) => Object.keys(a.rigup || {}).forEach((k) => { if (!V.rig.has(k)) out.push(w + ': rig-up key ' + k + ' not in WTS_sim.RIG_KEYS'); }));
  }));
  return out;
}

module.exports = [
  {
    name: 'HELPCOURSE shape: exercises with trainer notes and set-up form, FS-1/FS-2 open with "which pressure goes where", both variants, limits',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      openWts(app, {});
      fail(assert, shapeIssues(app, course, scenarios), 'course and scenarios');
      assert.ok(scenarios.some((s) => s.id === 'FS-4'), 'FS-4 cold start-up shipped');
      const V = engineVocab(app), ids = (l) => A(l).map((x) => x.id).join(',');
      const EX8 = 'ex1,ex2,ex3,ex4,ex5,ex6,ex7,ex8';
      if (!EQUIP.every((k) => V.optional.has(k))) {
        assert.strictEqual(ids(course), EX8, 'without DS-101 / T-202 in the engine: exercises 1–8');
        assert.strictEqual(ids(scenarios), 'FS-1,FS-2,FS-4,FS-5', 'without DS-101 / T-202 in the engine: FS-1, FS-2, FS-4, FS-5');
        assert.ok(!course.concat(scenarios).some((x) => /desander|DS-101|T-202/.test(JSON.stringify(x)) || x.shots), 'no sim-equip text or shot recipes on an engine without DS-101 and T-202');
      } else assert.strictEqual(ids(course), EX8 + ',ex9,ex10' + (V.optional.has('heaterChoke') ? ',ex11' : ''), 'sim-equip engine: exercises 1–10 (11 with CK-102)');
      // the sim-equip content, built against a stand-in engine, so its shape is checked on any engine
      const E = equipContent(app);
      assert.strictEqual(ids(E.course), EX8 + ',ex9,ex10', 'exercises 9 and 10 follow 8');
      assert.strictEqual(ids(E.scenarios), 'FS-1,FS-2,FS-3,FS-4,FS-5', 'FS-3 between FS-2 and FS-4; FS-5 (3.4.2) last');
      fail(assert, shapeIssues(app, E.course, E.scenarios), 'sim-equip course and scenarios');
      // §6.4 shot recipes: valid for help-shots.js, each shown by a { shot } block, phone shots of the viewport and the More menu
      const HS = require(path.join(BUILD, 'help-shots.js'));
      const shots = HS.collectShots({ course: E.course, scenarios: E.scenarios });
      fail(assert, HS.validateShots(shots), 'shot recipes');
      assert.ok(shots.length >= 14, shots.length + ' shot recipes');
      const unref = [];
      A(E.course).concat(A(E.scenarios)).forEach((x) => A(x.shots).forEach((s) => { if (JSON.stringify(A(x.blocks)).indexOf('"shot":"' + s.id + '"') === -1) unref.push(x.id + '/' + s.id); }));
      fail(assert, unref, 'shots without a { shot } block');
      const phone = shots.filter((s) => s.recipe.view === 'phone' || s.recipe.view === 'both').map((s) => s.folder + '/' + s.stem);
      ['course/ex1-view', 'course/ex5-more'].forEach((k) => assert.ok(phone.indexOf(k) !== -1, 'phone shot ' + k + ' (' + phone + ')'));
      ['course/ex2-ck101', 'course/ex4-scen', 'course/ex4-alarms', 'course/ex9-ds101', 'course/ex10-t202', 'scenarios/fs-1-rigup', 'scenarios/fs-1-cushion'].forEach((k) =>
        assert.ok(shots.some((s) => s.folder + '/' + s.stem === k), 'shot ' + k));
    },
  },
  {
    name: 'HELPCOURSE live references: tags, alarm ids and fault menu items read from the engine; bold phrases are page or simulator text',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      const V = engineVocab(app);
      assert.ok(V.faults.size >= 8 && V.tags.has('LSHH-301') && V.alarms.has('CHOKE_LIMIT'), 'engine vocabulary read');
      const items = course.concat(scenarios);
      fail(assert, refIssues(items, V).concat(boldIssues(app, items), simCheckShape(V)), 'references');
      // every fault the course injects is a real menu item
      const used = new Set();
      items.forEach((x) => strings(x, x.id, (s) => (s.match(/\*\*Scenarios → ([^*]+)\*\*/g) || []).forEach((b) => used.add(V.faults.get(b.slice(14, -2))))));
      ['oilDumpStuckClosed', 'surgePumpFail', 'xferStuckClosed'].forEach((f) => assert.ok(used.has(f), 'course injects ' + f));
    },
  },
  {
    name: 'HELPCOURSE steady numbers reproduce: calcWTS page checks for the exercises and FS-1 (a)–(d), FS-2 (e), FS-4',
    wp: WP,
    timeoutMs: 300000,
    run(app, assert) {
      const issues = [];
      let n = 0;
      Object.keys(CHECKS).forEach((id) => CHECKS[id].forEach((c, i) => { if (c.kind === 'page') { n++; pageCheck(app, id + ' page[' + i + ']', c).forEach((m) => issues.push(m)); } }));
      assert.ok(n >= 15, n + ' page checks');
      fail(assert, issues, 'page checks');
    },
  },
  {
    name: 'HELPCOURSE dynamic numbers reproduce on the simulator, incl. the FS-1 order on the live sim',
    wp: WP,
    timeoutMs: 900000,
    run(app, assert) {
      const V = engineVocab(app);
      fail(assert, simCheckShape(V), 'sim check shape');
      const all = [];
      Object.keys(CHECKS).forEach((id) => CHECKS[id].forEach((c, i) => { if (c.kind === 'sim') all.push([id + ' sim[' + i + ']', c]); }));
      if (!simInHarness()) { console.log('[help-course] ' + all.length + ' simulator check(s) skipped — ' + SIM_SKIP + ' (set WTS_HELP_SIMCHECKS=1 to run them on the HTML\'s Round 7)'); return; }
      const run = all.filter(([, c]) => hasItem(V, c));
      if (run.length < all.length) console.log('[help-course] ' + (all.length - run.length) + ' sim-equip simulator check(s) skipped — the engine has no ' + EQUIP.filter((k) => !V.optional.has(k)).join(' / '));
      const issues = [];
      run.forEach(([w, c]) => simCheck(app, w, c).forEach((m) => issues.push(m)));
      fail(assert, issues, 'simulator checks');
    },
  },
  {
    name: 'HELPCOURSE FS-1/FS-2 follow WTS_sim.features; worksheets print without answers or trainer notes; search finds the field answers',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      const H = app.win.WTS_help, S = app.win.WTS_sim;
      const today = (id) => JSON.stringify(scenarios.filter((s) => s.id === id)[0].today).slice(2, 40).replace(/\*\*/g, '');
      const plain = (h) => h.replace(/<[^>]+>/g, '');
      const had = S.features;
      try {
        S.features = undefined;
        let h = plain(H.renderList('scenarios'));
        assert.ok(h.split('Without the bypass destination (an older simulator)').length === 3, 'today notes (FS-1, FS-2) shown without the feature');
        assert.ok(h.indexOf('With V-101 out, well stream to') === -1, 'after-WP-SIM text hidden');
        S.features = { bypassDest: true };
        h = plain(H.renderList('scenarios'));
        assert.ok(h.indexOf('With V-101 out, well stream to') !== -1, 'after-WP-SIM text shown with the feature');
        assert.ok(h.indexOf('an older simulator') === -1 && h.indexOf('Cushion unload (clean-up)') !== -1 && h.indexOf('Production line pressure') !== -1, 'today text replaced: ' + today('FS-1'));
        assert.ok(h.indexOf('Which pressure goes where') !== -1 && h.indexOf('A shut-in well arrives cold') !== -1, 'intro and FS-4 unchanged');
      } finally { S.features = had; }
      course.forEach((x, i) => {
        const full = plain(H.renderExercise(x, i, {})), ws = plain(H.renderExercise(x, i, { worksheet: true }));
        assert.ok(full.indexOf('For the trainer') !== -1 && full.indexOf('Answers') !== -1, x.id + ': answers and trainer notes on screen');
        assert.ok(ws.indexOf('For the trainer') === -1 && ws.indexOf('Answers') === -1 && ws.indexOf(plain(x.answers[0]).slice(0, 30)) === -1, x.id + ': worksheet has no answers or notes');
      });
      const hits = (q) => H.search(q).map((r) => r.id);
      assert.ok(hits('burner').includes('FS-1') && hits('burner').includes('ex3'), 'burner → FS-1 and exercise 3: ' + hits('burner'));
      assert.ok(['FS-1', 'FS-2'].includes(hits('production pressure')[0]), 'production pressure → FS-1/FS-2 first: ' + hits('production pressure'));
      assert.ok(hits('cushion').includes('FS-1'), 'cushion → FS-1');
    },
  },
  {
    name: 'HELPCOURSE checks bite: unknown tag, fault label, missing debrief, wrong number, wrong alarm window',
    wp: WP,
    run(app, assert) {
      const { course, scenarios } = content(app);
      const V = engineVocab(app);
      const c = JSON.parse(JSON.stringify(course[3]));
      c.steps.push('Watch LSHH-999 and FAKE_ALARM.', 'Then **Scenarios → LCV-999 stuck**.');
      const r = refIssues([c], V).join(' | ');
      assert.ok(/tag LSHH-999/.test(r) && /alarm id FAKE_ALARM/.test(r) && /fault "LCV-999 stuck"/.test(r), r);
      assert.ok(/bold "no such button"/.test(boldIssues(app, [{ id: 'x', steps: ['Select **No such button**.'] }]).join(' ')), 'bold check');
      // a word that is only in comments or code of 38 (not in any string literal, not on the page) is not a label
      const src38 = readSrc('38-wts-live.js'), vocab = boldVocab(app);
      const codeOnly = (src38.match(/[A-Za-z]{9,}/g) || []).filter((w) => vocab.indexOf(w.toLowerCase()) === -1)[0];
      assert.ok(codeOnly && src38.toLowerCase().indexOf(codeOnly.toLowerCase()) !== -1, 'a word of the 38 source outside its string literals: ' + codeOnly);
      assert.ok(boldIssues(app, [{ id: 'x', steps: ['Select **' + codeOnly + '**.'] }]).length === 1, 'bold check ignores comments and identifiers (' + codeOnly + ')');
      openWts(app, {});
      const bad = JSON.parse(JSON.stringify(course));
      bad[0].trainer.debrief = ['one'];
      bad[1].form = { wts_nothing: 1 };
      const sh = shapeIssues(app, bad, scenarios).join(' | ');
      assert.ok(/debrief needs 3–5/.test(sh) && /form id wts_nothing/.test(sh), sh);
      const pc = pageCheck(app, 'neg', { kind: 'page', set: { wts_bean: 30 }, expectState: { 'flow.choke.QmaxMMscfd': 9.0 }, expectText: ['not on the page'] }).join(' | ');
      assert.ok(/QmaxMMscfd = 9\.41/.test(pc) && /does not show "not on the page"/.test(pc), pc);
      const sc = simCheck(app, 'neg', { kind: 'sim', run: 60, expect: [{ alarm: 'CHOKE_LIMIT', from: 0, to: 30 }, { at: 60, path: 'nodes.wellhead.P', v: 2000 }] }).join(' | ');
      assert.ok(/alarm CHOKE_LIMIT first at undefined/.test(sc) && /nodes\.wellhead\.P = 3000/.test(sc.replace(/3000\.\d+/, '3000')), sc);
      const sf = simCheck(app, 'neg', { kind: 'sim', run: 20, expect: [{ first: { path: 'esd.travel', v: 1 }, path: 'nodes.wellhead.P', max: 100 },
        { first: { path: 'esd.travel', v: 1 }, diff: ['nodes.wellhead.P', 'nodes.esd.P'], max: 0 }, { first: { alarm: 'ESD_TRIPPED' }, path: 't', v: 0 }] }).join(' | ');
      assert.ok(/nodes\.wellhead\.P at esd\.travel = 1 .* text says ≤ 100/.test(sf) && /\|nodes\.wellhead\.P − nodes\.esd\.P\|/.test(sf) && /ESD_TRIPPED never reached/.test(sf), sf);
    },
  },
];
module.exports.CHECKS = CHECKS;
