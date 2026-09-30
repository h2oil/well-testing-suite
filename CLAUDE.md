# CLAUDE.md — Project Memory for the Well Testing Suite

> Loaded at every Claude Code session start. Architectural conventions, build
> pipeline, file map, and gotchas. Keep this current — new conventions or
> recurring "I had to learn this the hard way" facts go here.

---

## TL;DR — What this project is

- **Single-file vanilla-JS HTML web app** (`well-testing-app.html`, ~76k lines as of v1.7). Zero external runtime deps; pure `Math.*` for all engineering modules. Deployed at `pb-handbook.com` historically — now standalone on `localhost:8080` via `npx http-server` for development.
- **iOS Capacitor wrapper** (`ios-app/`) — wraps the same HTML for App Store distribution. iOS builds via Xcode Cloud; Capacitor 8 (SPM). The iOS app is free — no in-app purchases / subscription SDK.
- **PRiSM module** is the flagship advanced Well Test Analysis tab, ~32k LOC of its own (pressure-transient + decline-curve workshop with 45 type-curve models, LM regression, auto-match, deconvolution, PVT, tide analysis, multi-dataset project files, etc.). Built across 21 numbered source files in `prism-build/` then concatenated and injected into `well-testing-app.html`.

---

## Repo layout

```
well-testing-app.html           ← single source of truth for the WEB app (~76k lines)
ios-app/
  www/index.html                ← derived from well-testing-app.html via sync-from-main.js
                                  (GA stripped, iOS additions injected)
  scripts/sync-from-main.js     ← regenerates ios-app/www/index.html
  ios-additions/                ← iOS-only JS/CSS (Capacitor bridge, meta tags, bundled PDF libs)
  ci_scripts/ci_post_clone.sh   ← Xcode Cloud post-clone hook
  PrivacyInfo.xcprivacy
prism-build/                    ← PRiSM module source (numbered files + tooling)
  01-foundation.js              ← Stehfest engine + Bessel + Ei + #1 Homogeneous + five-step shell (C9),
                                  C7 panel/hook registries, dataset commit + demo sample
  02-plots.js                   ← canvas plot fns incl. MDH (no IIFE — top-level so they hoist);
                                  C6 _prismAxes, pointer zoom/pan
  03-models.js                  ← 13 type-curve evaluators + WBS/skin fold (PRiSM_evalWbsSkin) + pseudo-skins
  04-ui-wiring.js               ← Tabs 2-6 render fns, PRiSM_buildPlotData / drawActivePlot / evalModelCurve
  05-regression.js              ← Levenberg-Marquardt + bootstrap CIs; fitPhysical / fitRate / runRegression
  06-decline-and-specialised.js ← Arps/Duong/SEPD/Fetkovich + double-pen + vertical pulse
  07-data-enhancements.js       ← Multi-format file parser + filters + col mapper
  08-composite-multilayer.js    ← Phase 5 (#6, #9, #11, #14, #15, #20, #21)
  09-interference-multilateral.js ← Phase 6 (#13, #19, #22-#37 — 16 models)
  10-specialised-solvers.js     ← Phase 7 (#18 user-defined, #38 water injection)
  11-polish.js                  ← 14 SVG schematics + 24 click-on-plot line tools + PNG + GA4
                                  (32 more schematics added 2026-04-26 — total 46)
  12-data-crop.js               ← Interactive Data-tab crop chart + numeric trim
  13-auto-match.js              ← Regime classifier + LM model race + top-N AIC ranking
  14-interpretation.js          ← Plain-English fit narrative + actions + cautions
  15-diagnostic-annotations.js  ← Auto-Bourdet-L picker + plot-regime markers
  16-pvt.js                     ← PVT correlations + dimensional conversion
  17-deconvolution.js           ← von Schroeter-Levitan deconvolution
  18-tide-analysis.js           ← Astronomical tide constituents + Bredehoeft ct
  19-data-managers.js           ← Gauge-data + analysis-data + project file (.prism)
  20-plt-inverse.js             ← Synthetic PLT + inverse rate-from-pressure
  21-plot-utilities.js          ← Plot overlays + diff plot + XML export + clipboard
  22-30                         ← units layer, Test System Safety calcs, tooltips, project save, quick report
  31-32, 38                     ← Well Test Simulator / 3D (Round-7 — separate workstream)
  33-pta-core.js                ← C1 getWell, C2 getAnalysisData/rateHistory, C3 physicalModel, C4 lastFit,
                                  C5 type-curve match, C8 save/restore state          (Round-8)
  34-semilog-skin.js            ← MDH/Horner/superposition straight lines, skin summary + decomposition (Round-8)
  35-rta-dca.js                 ← decline results (EUR, forecast, P10/50/90) + RTA plots/FMB   (Round-8)
  36-report.js                  ← Tab 7 report, PDF/CSV, job-report fragment             (Round-8)
  37-prism-workflow.js          ← results rail, ▶ Analyse, step ② flow periods, Tools drawer, undo/redo (Round-8)
  4N-calc-<key>.js              ← plug-in calculators (Round-9, auto-discovered) — see "Adding a calculator".
                                  v1.7: 41-calc-gasdeliv, 42-calc-oilipr, 43-calc-flareghg, 44-calc-h2sroe
                                  v1.8: 40-calc-tubulars (data only: WTS_tubulars), 45-calc-orifice, 46-calc-gaspvt,
                                  48-calc-wellkill (+WTS_gradient_compute), 49-calc-{sepqc,proving,chokeperf,flowline,
                                  lineheat,dispersion,scale,fluids}
  39-prism-fieldtools.js        ← R12 gauge register, R13 sequence of events, R15 ct builder (Round-8)   (v1.8)
  49-calc-gaslift.js            ← Gas lift quick design (v3.0; reuses WTS_flowline_march)
  47-calc-historian.js          ← Mini WellOS historian (v3.0): WTS_historian (SQLite WASM/OPFS → sql.js/IndexedDB →
                                  IndexedDB → memory), trend viewer, table, CSV/XLSX/.sqlite export + restore; libs lazy,
                                  SHA-384 pinned, bundled for iOS in ios-additions/libs
  50-a11y.js                    ← keyboard/ARIA/contrast layer + decimal-comma option (Round-6, v3.0)
  51-prism-workspace.js         ← N1 saved fits / compare / branches / model browser (Round-8, v3.0)
  52-prism-gas.js               ← N3 gas m(p) straight lines, pseudo-time, skin-vs-rate, AOF/IPR (Round-8, v3.0)
  6N-*.js                       ← Round-10 live data (auto-discovered): 60-modbus-core, 61-modbus-station,
                                  62-modbus-page (route modbus), 63-wellos (route wellos, Mini WellOS),
                                  64-modbus-bridge-pack (GENERATED by pack-modbus-bridge.js from tools/modbus-bridge/ —
                                  concat-round10 runs it first; never edit by hand), 65-modbus-bridge-setup (installer
                                  generator, zip writer, Check bridge)
                                  (use a free number; two files with the same number still load, ties by name)
  combined.js                   ← historical Phase 1+2 concat (no longer used)
  combined-phase1-2.js          ← Generated by concat-phase1-2.js (01 → 03 → 02)
  combined-phase3-4.js          ← Generated by concat-phase3-4.js (Tier 1)
  combined-round2.js            ← Generated by concat-round2.js (Tier 2)
  combined-round3.js            ← Generated by concat-round3.js (Tier 3)
  combined-round4…7.js          ← Generated by concat-round4…7.js (22 / 23-27 / 28-30 / 31-32+38)
  combined-round8.js            ← Generated by concat-round8.js (33-37)
  combined-round9.js            ← Generated by concat-round9.js (4N-calc-*.js)
  combined-round10.js           ← Generated by concat-round10.js (6N-*.js live data)
  concat-*.js, inject-*.js      ← Build pipeline scripts (inject-lib.js = shared idempotent splicer)
  smoke-test.js                 ← vm-sandboxed namespace + contract + no-perpetual-timer checks (311/311)
  accept-test.js                ← numeric acceptance runner over tests/*.test.js (776 tests; calc-g1…g5 = host-calculator audit,
                                  calc-new1…4 = v1.7 calculators, calc-registry = plug-in contract)
  tests/_harness.js             ← loadApp(): DOM store, recording canvas, manual timers, shared storage
  .tmp/                         ← Extracted main script for syntax checks (gitignored)
PRISM-PLAN.md                   ← Phasing plan + model catalogue + decisions
PROJECT-NOTES.md                ← Running changelog (newest on top)
README.md                       ← Public-facing description
```

---

## Build pipeline — DO NOT MISS A STEP

The PRiSM source files are concatenated and injected into `well-testing-app.html`
via numbered "rounds":

1. **Phase 1+2 (`combined-phase1-2.js`)** — files 01 → 03 → 02, now regenerable:
   `node prism-build/concat-phase1-2.js` + `node prism-build/inject-phase1-2.js`
   (sentinels `// ── PRiSM Phase 1+2 injection START/END ──`; the legacy DCA/PTA
   migration shim right after END is host code — leave it alone).

2. **Phase 3+4 (`combined-phase3-4.js`)** — files 04, 05, 06, 07.
   - Modify any of these files
   - Run `node prism-build/concat-phase3-4.js` (strips self-tests + concatenates)
   - Run `node prism-build/inject-phase3-4.js` (idempotent splice via sentinel comments)

3. **Round-2 (`combined-round2.js`)** — files 08-15.
   - Same pattern: `node prism-build/concat-round2.js` + `node prism-build/inject-round2.js`

4. **Round-3 (`combined-round3.js`)** — files 16-21.
   - Same pattern: `node prism-build/concat-round3.js` + `node prism-build/inject-round3.js`

4b. **Round-4** (22-units — Imperial/Metric layer), **Round-5** (23-27 Test System
   Safety: ESD Hi/Lo-Pilot, Hydrate, Liquid Line, Pipe Service Life), **Round-6**
   (28 help tooltips, 29 project save/open, 30 quick report). Same concat/inject
   pattern (`concat-round4.js` … `inject-round6.js`). Round-7 (31-32, 3D Well Test
   Simulator) belongs to a separate workstream — never run it from PRiSM work.

4c. **Round-8 (`combined-round8.js`)** — files 33-37 (PTA core, semilog/skin, RTA/DCA,
   report, workflow). `concat-round8.js` + `inject-round8.js`; sentinels
   `// ── PRiSM Round-8 injection START/END ──`, anchored after Round-7 END if present,
   else after Round-6 END. Missing files are skipped with a warning.

4e. **Round-10 (`combined-round10.js`)** — live data (Modbus, Mini WellOS, historian): every
   `prism-build/6N-*.js`, discovered like Round-9. `concat-round10.js` + `inject-round10.js`; sentinels
   `// ── Round-10 (live data) injection START/END ──`, after the Round-9 END. Do NOT use 5N names for
   live-data files (50-52 belong to Rounds 6 and 8).

4d. **Round-9 (`combined-round9.js`)** — plug-in calculators: every `prism-build/4N-calc-*.js`
   (N = 0-9), discovered from the directory in numeric order (no FILES list). `concat-round9.js` +
   `inject-round9.js`; sentinels `// ── Round-9 (calculators) injection START/END ──`, anchored
   after the PRiSM Round-8 END. See "Adding a calculator".

5. **Always then run** `node ios-app/scripts/sync-from-main.js` to regen www.

6. **Verify**: `node --check prism-build/.tmp/wts-main.js`, `node prism-build/smoke-test.js`
   (311/311 must pass), `node prism-build/accept-test.js --html --integration` (776/776) and
   `node prism-build/wts3d-test.js` (97 checks; on a Linux LF checkout check 14 timing and the two CRLF checks fail).

7. **Re-normalise CRLF** after any inject run. Some inject scripts splice their block with LF-only
   line endings (the v1.7 integration found ~38k LF-only lines after a full rebuild). Check with
   node (`(s.match(/(^|[^\r])\n/g)||[]).length` must be 0) and fix with
   `s.replace(/\r?\n/g,'\r\n')` before `sync-from-main.js` — never `sed -i`.

The full rebuild incantation (N = the node.exe path below; add rounds 4/5 when 22-27 changed and
round 7 only when 31-32/38 changed — at v1.7 all rounds 1-9 were rebuilt and round 7 was a no-op):

```bash
$N prism-build/concat-phase1-2.js && $N prism-build/inject-phase1-2.js && \
$N prism-build/concat-phase3-4.js && $N prism-build/inject-phase3-4.js && \
$N prism-build/concat-round2.js  && $N prism-build/inject-round2.js  && \
$N prism-build/concat-round3.js  && $N prism-build/inject-round3.js  && \
$N prism-build/concat-round6.js  && $N prism-build/inject-round6.js  && \
$N prism-build/concat-round8.js  && $N prism-build/inject-round8.js  && \
$N prism-build/concat-round9.js  && $N prism-build/inject-round9.js  && \
$N prism-build/concat-round10.js && $N prism-build/inject-round10.js && \
$N -e "const fs=require('fs');const f='well-testing-app.html';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))" && \
$N ios-app/scripts/sync-from-main.js && \
$N -e "
const fs = require('fs');
const html = fs.readFileSync('well-testing-app.html', 'utf8');
const m = html.match(/<script>\\s*\\/\\* ═+\\s*WELL TESTING SUITE([\\s\\S]+?)<\\/script>/);
fs.writeFileSync('prism-build/.tmp/wts-main.js', '/* ═══ WELL TESTING SUITE' + m[1], 'utf8');
" && \
$N --check prism-build/.tmp/wts-main.js && $N prism-build/smoke-test.js | tail -3 && \
$N prism-build/accept-test.js --html --integration | tail -3
```

### Acceptance tests (`accept-test.js`)

- Every `prism-build/tests/*.test.js` exports `[{name, wp, integration?, opts?, run(app, assert, ctx)}]`;
  each test gets a fresh app from `tests/_harness.js` (`loadApp`), with manual timers, a DOM
  store keyed by id, a recording 2D context and a shareable localStorage (reload tests).
- `--sources` (default) builds the main script in memory from `prism-build/`; `--html` loads the
  built `well-testing-app.html`. `--wp WP5`, `--file`, `--grep`, `--integration`, `--verbose`.
- Tests that pass `opts.sourceOverrides` (pin/remove files) always build from sources.

### Shared contracts (C1–C9) — code against these, never around them

- **C1 well & test inputs**: store `window.PRiSM_pvt` (persisted `wts_prism_pvt`, per-field
  `provenance`: default | user | sample | dataset | correlation | deconvolution). Write only with
  `PRiSM_setWell(patch, {source})` (fires `prism:well-changed`); read resolved values with
  `PRiSM_getWell()` → `{q,B,mu,ct,h,phi,rw,pi,testType,tp,…,missing[],defaulted[],complete}`.
  A pi with provenance `default` resolves to **null**. Committing a user-loaded (paste/file)
  dataset demotes `sample` inputs to `default`.
- **C2 analysis data**: `PRiSM_getAnalysisData(ds?, {period, timeFn, L})` → sign-aware Δp from
  pRef (pi → t≤0 row → extrapolation → first sample, flagged), time function, Bourdet derivative,
  rate history/periods. `PRiSM_rateHistory(ds)` periods are the list `st.activePeriod` indexes.
- **C3 physical model**: `PRiSM_physicalModel(key, well?, adata?)` → k, C, S, (xf|Lh), shape keys,
  optional pi; categorical/array parameters (BC, layers…) are `fixedKeys`, never regressed.
  Registry entries carry `kind`, `refLength`, `defaultFrozen`, `timeInput`, `scale:'log'`.
- **C4 last fit**: `PRiSM_setLastFit(fit)` / `PRiSM_getLastFit()` (fires `prism:fit-updated`).
  Fits carry `phys` (field units), `scales {A,B}`, `ci95`, `r2`, `converged`. Adopt
  `st.params/phys/tcMatch` **before** storing the fit so listeners see a consistent state.
- **C5 type-curve match**: `st.tcMatch {logPM, logTM}`; `PRiSM_matchToPhysical`. `st.match` is a
  read-only `{0,0}` legacy stub.
- **C6 plots**: `PRiSM_buildPlotData(key)` → `{data, opts}`; `data.dp` is always Δp; canvases carry
  `_prismAxes {toX,toY,fromX,fromY,plot,plotKey}`; `PRiSM_drawActivePlot()` is the single redraw
  entry point and runs `PRiSM_postDrawHooks` once per draw.
- **C7 panels, hooks, events**: `PRiSM_registerTabPanel(n, {id, title, order, when, render})` —
  cards mount in the sibling `#prism_tab_N_panels`. Events: `prism:dataset-loaded` (only via
  `PRiSM_commitDataset`), `prism:well-changed`, `prism:fit-updated`, `prism:model-changed`,
  `prism:period-changed`, `prism:step-changed`, `prism:tab-open`. **No polling / setInterval /
  function wrapping** — the smoke test fails on pending timers after 5 s idle.
- **C8 persistence**: `PRiSM_saveState()` / `PRiSM_restoreState()` (`wts_prism_state`, debounced
  one-shot save on C7 events); project files via `WTS_project` modules `pvt`, `prism_dataset`, `prism`.
- **C9 shell**: five steps (① Data ② Flow periods ③ Diagnose ④ Model & fit ⑤ Report) over tabs 1-7;
  `PRiSM_gotoStep(n,{tab})`, `PRiSM_currentStep()`; header `#prism_analyse_btn` → `PRiSM_analyse()`,
  `#prism_tools_btn` → `PRiSM_openTools()`, undo/redo; `#prism_rail` filled by `PRiSM_renderRail`
  (class `prism-rail--sheet` below 1024 px).

---

## Adding a calculator (plug-in registry, Round-9)

A new calculator is one file, `prism-build/4N-calc-<key>.js` (N = 0-9). `concat-round9.js` finds it
automatically. **Do not edit the host route table, sidebar or dashboard** — the host
(`// ── Plug-in calculator registry ──`, just above `// ── Navigation ──`) does it from the registry:
`render()` mounts the sidebar button (in the nav group whose label equals `group`, or a new group
placed before the footer) and falls back to the registry for any route that is not in its route
table. `renderHome()` adds a tile in sidebar order. `nav()` sets the active state for these buttons too.

```js
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  // … page code: window.calcMyKey(), pure window.WTS_mykey_compute(input), render(body) …
  G.WTS_calcRegistry = G.WTS_calcRegistry || {};          // merge, never replace
  G.WTS_calcRegistry.mykey = {
    key: 'mykey',                // must equal the property name; /^[a-z][a-z0-9_]{1,31}$/; not a built-in route
    title: 'My Calculator',      // plain text (escaped): #pgTitle, sidebar label, tile, report title
    sub: 'One-line subtitle',    // plain text: #pgSub
    group: 'Production & Reservoir',  // exact sidebar group label (case-insensitive)
    icon: '&#8599;',             // one numeric entity or ≤ 3 characters (anything else → ◆)
    render: function (body) { /* paint #pgBody */ },
    // optional: navTitle (shorter sidebar label), desc (tile text, default sub),
    //           badge + bc ('dc-b-green|orange|blue') for the tile, hooks (a PAGE_HOOKS entry for dynamic rows)
  };
})();
// === SELF-TEST ===
(function () { /* numeric checks of WTS_mykey_compute; stripped by concat */ })();
```

- **File rules**: single outer IIFE, public symbols only on `window`, no external deps. Loading must
  not fail when `document`, `WTS_units` or `drawLineChart` are missing (smoke stub). No timers,
  polling or function wrapping.
- **render(body)**: the host has already set `#pgTitle`/`#pgSub`. Then:
  1. `body.innerHTML = '<div id="<p>_root">…'`.
  2. Tag unit inputs with `WTS_units.tagInput(id, category)` (no `22-units.js` MANIFEST edit).
  3. Put listeners on `#<p>_root`, never on `body` (`#pgBody` survives navigation).
  4. Finally call `window.calc<X>()`.

  The host then restores autosaved values and fires input+change, so the page recalculates on its own.
- **calc**: name the function `window.calc<X>` (matches `/^calc[A-Z0-9_]/`) so the units layer
  wraps it in a canonical context. Tagged inputs then read imperial. Always call it as
  `window.calc<X>()`, never through a captured local. Also:
  - publish `window.WTS_state.<key>`;
  - recalculate on `document` `wts:unit-system-changed` once results exist.
- **Markup = free reports/autosave**:
  - id'd controls autosave to `wts_page_<key>` and travel in project files;
  - `.card` + `.card-title` and `.fg-item` (label + control) are captured as Inputs;
  - results go inside `#<p>_res` as `.rbox`/`.rbox-title`, `.rrow` `.rl`/`.rv`, `table.dtable`
    and `canvas` in `.chart-wrap`;
  - `✓ / ⚠ / ✗` verdict divs, plain text under 300 characters;
  - a `<div><b>Notes</b> …</div>` box.

  PDF/PNG export and the header Quick Report (per-page snapshots, ordered by the sidebar) then work
  with no extra code. Only computed numbers and fixed strings go into `innerHTML`.
- **Test** without writing the HTML. Round 9 is in the harness pipeline, so a file on disk is loaded
  by `loadApp({fromSources:true})`, and an in-memory file by
  `loadApp({ sourceOverrides: { '4N-calc-x.js': src } })`. `tests/calc-registry.test.js` is the
  reference. The smoke test checks `window.WTS_calcRegistry` and that every entry is well-formed.
- **Ship** (integrator): `concat-round9.js` + `inject-round9.js`, then sync. Add a `RELEASE_NOTES` item.

---

## Conventions (must follow)

### File-level (every prism-build/NN-*.js)

1. **Single outer IIFE** — `(function () { 'use strict'; ... })();`
   Exception: `02-plots.js` is intentionally NOT wrapped, so its `function PRiSM_plot_*` declarations hoist to the host main IIFE scope (which the dispatcher in 04 then bridges to `window.*`).
2. **Public symbols on `window.PRiSM_*`** — never collide with the host app namespace.
3. **Registry merge, never replace**:
   ```js
   window.PRiSM_MODELS = window.PRiSM_MODELS || {};
   window.PRiSM_MODELS.myKey = { pd, pdPrime, defaults, paramSpec, reference, category, description, kind };
   ```
4. **No external runtime dependencies** — pure vanilla JS + `Math.*`. SheetJS for XLSX is the one allowed exception (lazy-loaded from CDN at use time).
5. **Self-test at end** — `// SECTION N — SELF-TEST` or `// === SELF-TEST ===` marker followed by an IIFE. Stripped during concat.
6. **Defensive against missing primitives** — stub `window.PRiSM_lm`, `window.PRiSM_compute_bourdet`, etc. if absent so the file can run standalone in the smoke-test stub.

### Host file (well-testing-app.html)

- Whole script wrapped in `(function () { 'use strict'; ... })()` from line ~584 to near the end of the file (~65k lines). Everything PRiSM-injected lives inside that IIFE.
- Uses **CRLF line endings** in the Windows working copy, but git stores it (and `ios-app/www/index.html`) as **LF** — on Linux/macOS clones write LF or the diff touches every line. The injection scripts auto-detect (`html.includes('\r\n')`). Watch for git's "LF will be replaced by CRLF" warnings — they're harmless.
- The legacy DCA + PTA routes go to PRiSM: the route table (`const pages = {…}`, line ~1089) maps `prism`, `dca` and `pta` to `renderPRiSM` (the old duplicate `dca: renderDCA, pta: renderPTA` keys were removed; the dead `renderDCA` / `renderPTA` bodies are still in the host and can be deleted in a separate change).
- **Never `sed -i` well-testing-app.html** (Git Bash's sed rewrites the whole CRLF file as LF). Edit with the Edit tool or a small node script; if it happens, re-normalise with node (`s.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')`).
- **Node is not on PATH** in this Windows environment — use `/c/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`. `gh` is not authenticated: merge Dev → master with a temporary `git worktree` + `git merge --no-ff` + push.
- **Reports** (host, "UNIVERSAL PDF / PNG EXPORT"): `collectPageReport(root)` walks any page generically (`.card/.rbox` blocks → `.fg-item` pairs, input tables, loose row controls, `.rrow`, `.kpi` (`.kpi-l`/`.kpi-v`), tables, canvases, SVGs, ✓/✗ verdict banners, Rationale/Notes boxes) into one model; `renderReportBodyHTML` + `buildReportHTML` (PDF) and `exportPagePNG` render it. New pages get good exports for free if they use those classes. WebGL canvases should expose `canvas.__h2oilSnapshot()` → dataURL. The header Quick Report = `WTS_exportJobReport` (auto-captured per-page snapshots in `wts_report_snapshots`).
- **Persistence**: every id'd control in `#pgBody` autosaves to `wts_page_<route>` (plus legacy per-calculator `wts_<key>` lists); project files (`29-project-save.js`) snapshot all `wts_*`/`h2oil_*` keys. Escape anything read from storage before putting it into HTML (`_rEsc`, `_safeImgSrc`).
- **Modbus bridge** for the web version: `tools/modbus-bridge/` (Node, no deps; v1.1.0; localhost bind, host allow-list, writes refused unless `--allow-writes`, `--config bridge-config.json`, `GET /health` for accepted origins only, Origin `null`/`file://` refused unless opted in). Installers `install-windows.ps1` (PS 5.1-compatible, ASCII) and `install.sh` (bash 3.2-compatible; `.gitattributes` keeps `*.sh` LF) keep and merge an existing `bridge-config.json`. After editing any file in `tools/modbus-bridge/`, rebuild Round-10 so the in-app pack (and its sync test) is regenerated. The iOS app uses the native `ModbusTcpPlugin.swift` (registered in the app target, no SPM package) and needs `NSLocalNetworkUsageDescription`.
- **iOS-only layout/behaviour** goes in `ios-app/ios-additions/ios-styles.css` / `ios-bridge.js`, scoped under `html.ios-app` (set only in the app) — never change the web layout for iOS. Form controls are ≥ 16 px there (iOS zooms on smaller inputs). In the app three.js is imported directly from `capacitor://localhost/three.module.min.js` (`WTS_3d.loadInfo()` shows the route). `prism-build/ios-webkit-check.js` runs a WebKit layout/3D check when Playwright is available.
- **Units** (`22-units.js`): calcs stay imperial. Result text on host pages goes through `_uFmt(v, cat, dp, impLabel, dpMet)` / `_uMetric()` (defined next to `__unitsApi`) so Metric mode shows converted values, not just labels. Inside any `window.calc*` / export call or `#pgBody` event, tagged inputs' `.value` returns canonical imperial; outside it returns the display text. Use `WTS_units.runCanonical(fn)` when calling calc code from elsewhere. Natively-SI fields are deliberately untagged.

### Math conventions

- **Time in HOURS**, pressure in PSI, rate in STB/d (oil) or MSCF/d (gas). Field units throughout, NEVER SI.
- **Sign-aware Δp** — when computing Bourdet derivatives, use:
  ```js
  var sign = (p[n-1] - p[0]) >= 0 ? 1 : -1;   // +1 buildup, -1 drawdown
  for (var i = 0; i < n; i++) deltaP[i] = sign * (p[i] - p[0]);
  ```
  This was the cause of a catastrophic auto-match bug (drawdown → negative Δp → log10 NaN → only Arps survived race with R²=−195). See commit `34258bf`.
- **Stehfest weights precomputed** in `window.PRiSM_STEHFEST_W` (length-12 array). Re-use, don't recompute.

### Commit messages

- Reference commits, files, line numbers when fixing bugs ("see `34258bf`").
- Always co-author `Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Never name competitor products** (specifically: don't write "PIE" anywhere — user instruction). Describe features generically as "feature update" / "advanced deconvolution" / "tide analysis for offshore wells" etc.

### iOS deployment notes

- **The iOS app is free and fully unlocked — no in-app purchases, no subscription SDK, no paywall.** The subscription SDK and `ios-additions/ios-subscriptions.js` were removed entirely (its Swift package broke Xcode Cloud archives). Don't re-add an IAP/subscription SDK without an explicit user decision.
- Capacitor 8 (Swift Package Manager — **no CocoaPods / Podfile**). Don't downgrade. Capacitor 8 CLI needs **Node ≥ 22**.
- SPM wiring: `npx cap sync ios` regenerates `ios-app/ios/App/CapApp-SPM/Package.swift` from the plugins in `ios-app/package.json`. Xcode Cloud resolves packages strictly from the committed `ios-app/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` — whenever a plugin is added/removed/upgraded, re-resolve in Xcode on a Mac and commit the updated `Package.resolved`, or the archive fails with "out-of-date resolved file".
- The `ci_scripts/ci_post_clone.sh` hook (Xcode Cloud runs the copy in `ios-app/ios/App/ci_scripts/` — keep both copies identical) ensures Node ≥ 22, runs `npm ci --ignore-scripts`, regenerates `ios-app/www/` (`npm run sync-main`), runs `npx cap sync ios`, and stamps the version from `CI_BUILD_NUMBER`.
- `ios-app/package-lock.json` must stay in sync with `package.json` (`npm ci` hard-fails otherwise).

---

## Branch model

- `Dev` — active development. Default for all session work.
- `master` — stable, what the iOS sync workflow and Xcode Cloud ("Build Auto Sync") consume.
- `git push origin Dev` after every commit, then **merge Dev → master automatically once a batch is verified** (user instruction — don't wait to be asked).
- The `ios-sync.yml` action commits a regenerated `ios-app/www/index.html` to master after merges ("chore(ios): auto-sync www…"), so the next Dev → master merge usually conflicts on that generated file — resolve with Dev's copy (`git checkout --theirs ios-app/www/index.html`), since it was generated from the same HTML being merged.
- Every shipped batch also updates the in-app Release Notes (`RELEASE_NOTES` array in the host) — engineering changes only; never mention competitor research or paywalls.

---

## Known limitations (verified, not-yet-fixed)

- **Phase 6 multi-layer XF synthetic PLT** uses Warren-Root-style time-domain interpolation, not the rigorous Park-Horne 1989 NxN Laplace decomposition. Adequate for engineering work.
- **Water injection model** uses piston-front displacement, not full Buckley-Leverett saturation fan, and has `timeInput:'days'`, so `PRiSM_physicalModel` refuses it (no physical-unit pressure fit).
- **fogBoundary** is a constant partial-image approximation of a leaky fault; `partialPenFrac` is a Green's-function shortcut.
- **Horizontal-family fits are slow** (≈40-90 ms per pd+pd′ evaluation): a physical LM fit of `horizontal` takes ~20 s.
- **Gas**: deconvolution, inverse simulation and RTA FMB use liquid-equivalent Δp or warn (semilog p1hr / p* / ΔpS are converted back to psia since v3.0).
- **Decline type-curve matching** (Blasingame / Agarwal-Gardner stems for k, S, re) is not implemented; the RTA panel gives FMB and √t linear-flow only.
- Crop window, step ② selection and derived datasets (tide-corrected, deconvolved) are not persisted across a reload.

---

## Smoke test (always run before commit)

```bash
node prism-build/smoke-test.js
# Expect: "[ok] all 311 smoke-test checks passed"
# PRiSM_MODELS total: 45 entries
node prism-build/accept-test.js --html --integration
# Expect: "[ok] all 776 acceptance tests passed"
```

If a check fails, the test prints which one. Common failures and fixes:

- `window.PRiSM_X is not a function` — the file defining X didn't get re-injected. Re-run the appropriate `concat-*.js` + `inject-*.js`.
- `PRiSM_MODELS count >= 45` fails — a model entry got accidentally overwritten. Check that all six `combined-*.js` files were concatenated.
- Syntax check fails — most likely you copied an SVG with raw `<` characters into a JS string. Use `&lt;` etc.

---

## Common slash commands / agent dispatches

- **Bug fix workflow**: identify file → edit → run the rebuild incantation above → smoke test → commit + push.
- **New calculator page**: one `prism-build/4N-calc-<key>.js` that registers in `window.WTS_calcRegistry` (see "Adding a calculator") — no host edits.
- **New feature in PRiSM**: add a new numbered file `prism-build/NN-*.js`, follow the conventions, add to the next round's `concat-*.js` FILES list, add `inject-*.js` if a new round, extend `smoke-test.js` checks list and add a `tests/*.test.js`. Or piggy-back on an existing round if the feature is small.
- **Browser QA**: use the built-in browser tools (`mcp__Claude_Browser__*`) in your own tab (`tabs_create`, pass its tabId everywhere; never drive the tab named "seed"). Navigate `http://localhost:8080/well-testing-app.html` (add `?v=…` to bypass the http-server cache). localStorage is shared with other tabs on that origin: snapshot it first and restore it before closing your tab.

---

## Cumulative stats (as of 2026-09-29, v1.7 integration)

```
PRiSM source files:           01-21 + 33-37 (Round-8) + tooling
Plug-in calculators:          19 (Round-9, incl. historian) in WTS_calcRegistry + data module WTS_tubulars; live data (Round-10): modbus, wellos
Type-curve models:            45 in PRiSM_MODELS (41 transient + 4 decline)
SVG schematics:               46 (covers all 45 models + generic placeholder)
Click-on-plot line tools:     24
Decline curve types with EUR: 4 (Arps, Duong, SEPD, Fetkovich) + P10/P50/P90
PVT correlations:             17 (Standing, DAK, Lee-Gonzalez, Beggs-Robinson, etc.)
Smoke-test checks:            311/311 pass
Acceptance tests:             776/776 pass (accept-test.js --html --integration and --sources)
3D simulator tests:           97 checks (wts3d-test.js)
Generated HTML:               ~76.1k lines (4.24 MB); www bundle ~4.27 MB
```

Latest release: v3.0.1 (bridge installers + setup guide, well-menu fix) on top of v3.0 (Mini WellOS + Modbus, multi-well projects, PRiSM workspace + gas, gas lift, standards review of metering/erosion/ESD/simulator safety, a11y/perf, UX), integrated 2026-09-30. iOS marketing version is stamped 3.0.<CI_BUILD_NUMBER> by ci_post_clone.sh (VERSION_BASE).

**Shared engines (reuse, never duplicate):** `WTS_aga3_compute` (host; AGA-3 page, Oil & Gas, Orifice; Fpv = √(Zb/Zf), `gravityBasis` real|ideal), `WTS_flowline_march`, `WTS_modbus` (tags, polling; feeds `WTS_historian.record`; tag names are unique), `WTS_historian`, `WTS_wells` (multi-well; active well's keys stay where pages read them), `WTS_gaspvt_compute`, `WTS_tubulars`, `WTS_wellkill_compute` / `WTS_gradient_compute`, `WTS_baseConditions` + host `_baseCond(defTbF, defPb)` (Std selector; "calculator default" keeps each page's legacy basis), host `_uFmt`. Open engineering decisions: docs/ROADMAP.md §1.7.
