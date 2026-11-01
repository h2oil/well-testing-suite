# Project Notes — Well Testing Suite

Running log of significant changes, fixes, and architectural decisions. Newest entries on top.
All changes land on `dev`; `master` is the stable tree consumed by the iOS sync workflow.

---

## 2026-11-01 — v3.3 WP8: Build-up Surveillance confidence labels calibrated

`node prism-build/buildup-validate.js --sequences --workers 4 --write` on 640 single synthetic build-ups (15 strata, 126 of them
distractors the engine does not model) and 120 multi-test wells (993 build-ups): 1,683 labelled build-ups, 5-fold cross-validation grouped
by well, out-of-fold reliability tables. Plan: docs/BUILDUP-SURVEILLANCE-PLAN.md §5.4 (method) and §5.7 (results). The report, file 55
and the benchmark snapshot come from one run; the shipped tables come from a second out-of-fold pass over a re-run with the candidate
table, so they carry the KC2 envelope cap exactly as the app labels.

**Fixed at the root first** (the diagnosis separated engine faults from honest difficulty): the precursor chain at coarse sampling and
the tabled closing ramp in the data layer (Δq read the pre-cut rate / the last ramp row; DA27, DA28); the page's 24-case check repeats
the calibration run exactly (BM3); `confidence().rates` at the stored precision (EN23); the scorer treats an intra-day decrease of ≥ 10 %
as the partial cut the engine's gate makes of it (GE8c).

**Fix round (review of WP8, same day):**
- The page's "near a threshold" now needs the evidence within 0.1 of a calibrated threshold AND the expected labels reproduced by moving
  that one threshold by 0.1 (`PRiSM_autoInterp.nearThreshold`); any difference shows ⚠, never ✓ (the first rule showed real regressions
  as a pass; BM4, BM5).
- The generator's expected IARF grade uses the engine's definition on the noise-free derivative against the input-consistent
  superposition time (the given allocation); the demo durations were re-chosen (168, 64, 32, 30, 48, 54, 48, 60, 66 h; B1 good, B2–B9
  fair, every grade ≥ 0.1 from the next) and IN1 asserts the exact grade on all nine.
- The tables and shares include the KC2 envelope cap (the first WP8 figures were computed without it); `confidence().rates` and the
  Skin-check card quote the label's single-build-up row next to the pooled rate, and the report's calibration tables carry it as a column.
- The threshold search adds two strict passes while the incumbent is infeasible and reports what it searched (20,377 candidates per
  search, none feasible); the fallback set uses the strictest rate tolerance (10 %).

**Outcome: no searched candidate meets every constraint, so the stricter set is shipped (§5.4: targets never relaxed)** — every LOW and
HIGH label threshold of the grid at its strictest value: SNR_d high 30 / low 8, S_err high 0.3 / low 0.8, fair span 1.0, point-skin
spread 0.2, rate tolerance 10 %, disagreement 0.7 / 10 %, reach factor 5.0, KL9 on, k-held RMS 2; the S_err floor (0.2) and τ_BIC (10)
keep their pre-calibration values (the floor changes S_err itself, τ the model choice). Failing: the three single-case Wilson lower bounds
— k/S high 0.57 on 5 cases and headline high 0.21 on 1 (every single-case high label is right; there are too few for 0.90) and headline
medium 0.64 (72.6 % of 124): visible rivals below the T-up trigger and noise-level skin errors stay medium, and no calibrated threshold
separates them.

| k/S label | n | k and S right | Wilson 95 % | cluster 95 % | single cases |
|---|---|---|---|---|---|
| high | 112 | 100.0 % | 96.7–100 % | 100–100 % | 5, 100 % |
| medium | 704 | 97.2 % | 95.7–98.2 % | 95.7–98.4 % | 123, 83.7 % |
| low | 867 | 46.7 % | 43.4–50.0 % | 40.4–52.5 % | 492, 31.9 % |

| Headline label | n | fully right | Wilson 95 % | cluster 95 % | single cases |
|---|---|---|---|---|---|
| high | 80 | 100.0 % | 95.4–100 % | 100–100 % | 1, 100 % |
| medium | 733 | 95.4 % | 93.6–96.7 % | 93.4–96.9 % | 124, 72.6 % |
| low | 870 | 44.5 % | 41.2–47.8 % | 38.3–50.5 % | 495, 28.1 % |

- Share labelled high, as the app labels: 4.8 % headline (0.2 % of the single cases), 6.7 % k/S (0.8 %); without the envelope cap
  5.7 % / 7.8 % (1.0 % / 1.9 %). 589 of the 1,683 build-ups lie outside the envelope, whose Δt_end range starts at 10 h (pooled set),
  so no build-up shorter than 10 h is labelled high. Brier 0.149, BSS 0.299 (reliability 0.006, resolution 0.070, uncertainty 0.213).
- S_err coverage (|ΔS| ≤ 2·S_err): 98.2 % / 98.4 % (k/S high / medium), 98.8 % / 98.4 % (headline).
- False-rival rate on homogeneous truth 0 %; abstention 6.8 % overall, 5.2 % on `hom` (7.8 % of the single `hom` cases).
- Rate accuracy (engine Δq vs the input-consistent rate): median 0.01 %, P90 0.60 %. C within ±25 % (unit slope sampled) 90.9 %.
- Sequences (re-run with the calibrated table): delta false alarms 0 %, absolute 1.7 %; median confirmed delay 1 test (1 on 24–48 h
  wells); onset within one interval 94.9 %; Sen CI coverage 41.7 % (target 85 %, open); stimulation without a workover date → shut-in
  6 of 6; no delta alert on constant-skin gas wells with D resolved (3 of 3). **Shipped delta-alert form: plain.**
- Reach ≥ 90 % in every stratum except injectors 83 % (sub-threshold fall-offs) and changing storage 89 %; partial-cut status 3 of 10.
- Acceptance test `tests/buildup-benchmark.test.js`: BM1 snapshot of 10 seeds, BM2 no wrong high (6 lite high cases and one sequence
  well), BM3 the page's check, BM4 a wrong expectation reported as different, BM5 `nearThreshold`.
- Open (plan §12.1): the three single-case lower bounds (k/S high, headline high, headline medium), the envelope population, Sen CI
  coverage, injector and changing-storage reach, partial-cut status, review + report timing (83 ms against 50 ms).

---

## 2026-04-26 — PRiSM module: 21-file build, 45 type-curve models, ~32k LOC

Cumulative session work across 6 commits on `Dev`. Brings the PRiSM Well Test
Analysis module to a full well-test-analysis feature set (type-curve library,
regression, auto-match, deconvolution) while keeping the zero-dependency
single-HTML-file architecture intact.

### Commits (earliest → latest)

| SHA | What |
|---|---|
| `bc42c68` | Phase 3+4 — Levenberg-Marquardt regression engine (Marquardt scaling = `diag(JᵀWJ)`, Jacobian CIs, AIC, R², bootstrap), multi-rate superposition, Agarwal sandface convolution, 7 new models (Arps + Duong + SEPD + Fetkovich decline curves with EUR; double-porosity 3 modes; partial-penetration; vertical pulse-test), multi-format Data tab (CSV / TSV / DAT / ASC / XLSX / XLS / ODS via SheetJS lazy-load) with column auto-mapper + filters (MAD / Hampel / moving-avg) + decimation (Nth / log / time-bin) + unit converters. **5,543 LOC** across 4 background agents (A/B/C/D). PRiSM_MODELS: 12 → 19. |
| `60b1847` | Critical bug fix — Phase 1+2 plot fns (declared as top-level `function` decls in `02-plots.js`) hoisted to host IIFE scope but were NOT placed on `window`. Agent A's `PRiSM_drawActivePlot` dispatched via `window[entry.fn]` → undefined → "Plot function PRiSM_plot_xxx not available" error text overlaid on canvas. Fix: `_bridgePlotFnsToWindow()` at top of 04-ui-wiring.js IIFE assigns each Phase 1+2 plot fn (resolved via lexical-scope eval) to its `window.*` equivalent. Plus `PRiSM_drawCanvasMessage()` helper that clears canvas before fillText so successive failed renders don't stack. Plus empty-state guard. |
| `8014664` | Phases 5-7 + cross-cutting + auto-match + interpretation + crop — **10,774 LOC** across 8 background agents (E-L). Adds: 7 composite/multi-layer models (Phase 5: #6, #9, #11, #14, #15, #20, #21); 16 interference + multi-lateral models (Phase 6: #13, #19, #22-#37 from Kuchuk SPE 22731); 2 specialised solvers (Phase 7: #18 user-defined type-curve + #38 water injection); 14 SVG schematics + 20 click-on-plot analysis keys + PNG plot export + per-tab GA4 events; interactive Data crop chart with drag-select + numeric trim + first/last preview; auto-match orchestrator (regime classifier → LM model race → top-N AIC ranking with smart initial guesses); plain-English interpretation (18 param-tag rules + 11 action templates + confidence-aware verbs); auto-Bourdet smoothing-L picker (high-pass residual RMS → L band); diagnostic-plot annotations (regime-transition markers). PRiSM_MODELS: 19 → 45. |
| `34258bf` | Three QA-driven fixes from end-to-end Chrome MCP browser walkthrough. **(1)** Tab 3 schematic SVGs never displayed — Agent A built a placeholder div, Agent H built the SVG library, neither wired together. Fix: `#prism_schematic_host` element + after-render hook calls `PRiSM_getModelSchematic`. **(2)** Auto-match drawdown sign bug — classifier computed `Δp = p[i] - p[0]` which goes NEGATIVE on drawdowns → `log10()` NaN → zero candidates → only Arps survived race with R² = -195. Fix: detect flow direction from `sign(p[end]-p[0])` and use sign-aware Δp at all three sites (classifier, initial-param suggester, LM data prep with mirrored pressure). **(3)** Plot/Param/Match canvas heights now `calc(100vh - 320/360/340 px)` with `min-height: 480-500 px` instead of fixed 500/340/380 — fills viewport on tall screens. |
| `1b8fac7` | Round-3 expansion — **10,744 LOC** across 6 background agents (M-S). Adds: PVT layer (1548 LOC, 17 correlations: Standing Bo/Pb/Rs, Vasquez-Beggs co, Beggs-Robinson μ_o, Sutton pseudocriticals, Dranchuk-Abou-Kassem Z, Hall-Yarborough Z alt, Lee-Gonzalez-Eakin μ_g, Meehan Bw/μ_w/cw + gas pseudo-pressure m(p) Simpson integral) + dimensional conversion (`PRiSM_dimensionalize` with 6 k-inference fallback paths); deconvolution (1971 LOC, von Schroeter-Hollaender-Gringarten + Levitan with TV regularisation, Huber-smoothed |d|, exponential parameterisation g(τ)=exp(z), L-curve λ picker with max-curvature corner, custom in-file LM kernel); tide analysis (1475 LOC, harmonic regression for 10 astronomical constituents M2/S2/N2/K2/K1/O1/P1/Q1/Mf/Mm + Bredehoeft 1967 ct estimate from M2 phase response); data managers (2063 LOC, IndexedDB → localStorage → memory backend chain, gauge-data + analysis-data CRUD + diff + sampler, project save/load .prism JSON with base64 Float32 buffers at 12 bytes/sample); synthetic PLT + inverse simulation (1816 LOC, per-layer rate contribution with Warren-Root–style XF interpolation + linear deconvolution rate-from-pressure with Tikhonov + non-neg clip); plot utilities (1871 LOC, multi-period overlays + 2-dataset diff + portable XML export ~33 KB compact + clipboard PNG via ClipboardItem). |
| `3f3a5d1` | UI rebuild — **(1)** Tab 6 was still showing "Phase 3 preview" stub even though LM regression has been live for many commits. Rebuilt with proper workshop: initial-param table with freeze toggles, R²/RMSE/AIC/CI95 results panel, "Run regression" + "Run auto-match" buttons, ranked top-N panel via `PRiSM_renderAutoMatchPanel`. Plus reusable `PRiSM_renderRegressionResultsInto(container, fit)` helper. **(2)** Added 32 missing model schematics — Round-2 polish shipped 14 but `PRiSM_MODELS` has 45 entries. Now covers all 45 (closedChannel3, fogBoundary, all 4 decline curves, all composite/multi-layer/interference variants, userDefined, waterInjection). Shared SVG helpers added: `_svg_layers`, `_svg_xflowArrow`, `_svg_seal`, `_svg_declineCurve`, `_svg_obswell`. **(3)** ⟳ Reset View buttons added on all three plot canvases (Tab 2 picker bar, Tab 4 card title, Tab 5 caption). Each clears `_prismOriginalScale` + `_prismHandlers` + `_prismAxes` then triggers fresh render → auto-scale. |

### Verification

- **Smoke test:** `node prism-build/smoke-test.js` → 84/84 namespace checks pass.
- **Syntax:** `node --check` clean on all 21 prism-build/*.js source files + the merged HTML main script (1.79 MB).
- **Browser QA:** end-to-end Chrome MCP walkthrough by 2 background agents (core 7-tab + Round-2 features) — bugs surfaced were fixed in `34258bf` and `3f3a5d1`.

### Files added

- `CLAUDE.md` (new) — architectural conventions + build pipeline + file map. Loaded at every session start.
- `prism-build/04-ui-wiring.js` (modified, was Phase 3+4)
- `prism-build/05-regression.js` through `prism-build/21-plot-utilities.js` (17 new files, 11/15/16 modified for QA fixes)
- `prism-build/concat-phase3-4.js`, `concat-round2.js`, `concat-round3.js` (build pipeline)
- `prism-build/inject-phase3-4.js`, `inject-round2.js`, `inject-round3.js` (idempotent splice)
- `prism-build/combined-phase3-4.js`, `combined-round2.js`, `combined-round3.js` (generated)
- `prism-build/smoke-test.js` (extended to 84 checks)
- `PRISM-PLAN.md` updated — Phase 5/6/7 + cross-cutting all `[x]`, Round-2 + Round-3 capability sections added.

### Known limitations carried forward

See `CLAUDE.md` "Known limitations" section. Top items: foundation `PRiSM_Ei` returns NaN for negative arguments (Phase 6 worked around with `_localE1`); `02-plots.js` doesn't stash `_prismAxes` on canvas (analysis keys degraded); `07-data-enhancements.js` doesn't fire `prism:dataset-loaded` event (workaround via re-render). All flagged for future cleanup pass — none break shipped functionality.

### Next session checklist

- Real-browser regression on a representative dataset (manual or via Chrome MCP).
- Decide on PR to master once stable (current PR pending: see compare URL).
- Consider building Tier-2/3 enhancements from earlier brainstorm (synthetic test generator, period-by-period consistency check, Monte Carlo histograms surfacing the bootstrap CIs already computed, type-curve atlas for discoverability, multi-well batch fit).

---

## v1.1–v1.3 (iOS, superseded) — subscription paywall added, then removed

A third-party subscription SDK, a native paywall and an HTML fallback paywall were added in
v1.1–v1.3 (alongside the Capacitor 6 → 7 → 8 upgrades) and then removed entirely: the SDK's Swift
package broke Xcode Cloud archives. The iOS app is free and fully unlocked — no in-app purchases,
no subscription SDK, no paywall. See CLAUDE.md "iOS deployment notes".

---

## App Store rejection fix (Guideline 2.3.8 — placeholder-looking icons)

**Reviewer feedback**: "The app icons appear to be placeholder icons."

**Root cause**: My first `make-assets.py` composed the H2Oil wordmark at 72%
width on the 1024×1024 canvas, leaving ~60% of the area as dark empty space.
At small sizes (60pt home-screen, 40pt spotlight) the logo shrank into a tiny
mark surrounded by a dark square — reviewers correctly read this as "default
dark-square placeholder with a logo pasted in the middle."

**Fix**:
- Auto-crop the source logo to its alpha bounding box (removes the built-in
  padding in the PNG).
- Scale the wordmark to **92% of the icon's longest axis** — leaves just
  enough margin for iOS's corner rounding without wasting area. The H₂OIL
  wordmark with droplet now fills the icon and is legible from 20pt spotlight
  through 1024pt App Store listing.
- Splash bumped to 60% fill (from 50%) for visual parity with the icon.
- Dropped the droplet-only variant — while cleaner at tiny sizes, losing the
  "H2Oil" wordmark made it a generic oil-drop symbol that wouldn't help users
  identify the app.

Regenerate after any logo change:
```bash
cd ios-app && npm run assets   # make-assets.py → @capacitor/assets → ios/
```

---

## PDF export on iOS (real fix — prior one was a no-op)

**Problem**: PDF export on iOS never triggered the bundled jsPDF pipeline —
it still fell through to `window.print` which WKWebView handles poorly, AND
the cover page (client info + client logo + H2Oil logo) was missing.

**Root cause**: `exportReport` and `buildReportHTML` live inside the main app's
top-level IIFE (`(function(){...})()`). They were never attached to `window`,
so the iOS bridge's `window.exportReport = ...` assignment created an
unrelated global that no internal call site ever touched. Every calculator
calls the local `exportReport` (resolved lexically inside the IIFE), which
took the popup/iframe print path.

**Fix**:

- `well-testing-app.html`: added two minimal hooks right next to the existing
  definitions —
  - `window.buildReportHTML = buildReportHTML` so wrappers can build the
    styled HTML report with the cover page.
  - At the top of `exportReport`: `if (typeof window.__reportOverride === 'function') return window.__reportOverride(title, contentHTML)`.
- `ios-bridge.js`: sets `window.__reportOverride` instead of overriding
  `window.exportReport`. The override calls `window.buildReportHTML` (picks up
  client info + client logo + H2Oil logo automatically), converts to PDF
  via bundled jsPDF + html2canvas, then saves via `Filesystem.writeFile` +
  native share sheet.

**Also hardened `getH2OilLogoBlack`**: iOS WKWebView's `ctx.filter='invert(1)'`
is unreliable. Added a per-pixel invert fallback (reads the ImageData, flips
RGB when the average brightness is still high after drawImage), so the H2Oil
logo on the PDF cover is guaranteed black on the white cover page.

**Client info on PDF** (what the user asked about):
`buildReportCoverHTML()` already pulls from `localStorage.h2oil_client_info`
and emits a `<div class="logo-row">` (client logo + H2Oil logo) and a
`.meta-tbl` (Client, Well, Field, Operator, Rig, Reference, Date, Engineer,
Company). Once the iOS override correctly calls `buildReportHTML`, all of
that flows through to the generated PDF automatically. No separate wiring
needed — the same cover you see on the web version now prints on iOS too.

---

## App icon + splash screen (H2Oil branding)

Source assets live in `ios-app/resources/` and are generated from the sidebar logo
embedded in `well-testing-app.html` (base64 PNG at line ~281).

- `icon.png` (1024×1024, opaque `#0d1117`, logo at 72% width) — App Store icon
- `splash.png` (2732×2732, opaque `#0d1117`, logo at 45% width) — launch image
- `splash-dark.png` — same as splash (app is already dark-themed)
- `icon-foreground.png`, `icon-background.png` — optional Android adaptive pieces

**Regenerate**: `python3 scripts/make-assets.py` (if logo changes) then
`cd ios-app && npx @capacitor/assets generate --ios`. The assets plugin writes
all required sizes into `ios/App/App/Assets.xcassets/`.

---

## Full-screen layout fix (portrait top gap + landscape right bar)

**Problem**: Large black gap above the mobile header in portrait, and a black strip
on the right in landscape. Caused by *three* overlapping safe-area mechanisms
stacking on top of each other:

1. `capacitor.config.json → ios.contentInset: "always"` — WKWebView applies its
   own safe-area inset.
2. `StatusBar.overlaysWebView: false` — pushes the whole webview down by the
   status-bar height.
3. CSS `.main { padding-top: env(safe-area-inset-top) }` — added another inset.

**Fix** (consistent edge-to-edge strategy):

- `contentInset: "never"` — webview fills the screen.
- `StatusBar.overlaysWebView: true` — status bar sits on top of webview.
- `viewport-fit=cover` (already in `ios-meta.html`) — exposes `env(safe-area-inset-*)`.
- CSS (in `ios-styles.css`) applies insets to the actual UI chrome:
  - Mobile: `.mob-header` absorbs top + left + right insets; `.main` absorbs
    left/right/bottom; drawer `.sidebar` absorbs top/left/bottom.
  - Desktop/tablet: full-height `.sidebar` absorbs top + left; `.main` absorbs right;
    `.page-body` absorbs bottom.
- `html, body { background: var(--bg1) }` so the status-bar / home-indicator gutters
  paint the app colour instead of black.

After the fix the app fills the screen in both orientations; only the actual
status-bar / dynamic-island / home-indicator zones are reserved.

---

## Repository layout

```
well-testing-suite/
├── well-testing-app.html      ← single source of truth (the whole web app)
├── ios-app/                   ← Capacitor iOS wrapper
│   ├── capacitor.config.json
│   ├── package.json
│   ├── www/                   ← generated; do NOT edit by hand
│   │   ├── index.html         ← produced by scripts/sync-from-main.js
│   │   ├── capacitor.js
│   │   ├── jspdf.umd.min.js
│   │   └── html2canvas.min.js
│   ├── ios-additions/         ← iOS-only snippets injected into index.html
│   │   ├── ios-meta.html
│   │   ├── ios-styles.css
│   │   ├── ios-bridge.js
│   │   └── libs/              ← bundled for offline PDF export
│   ├── scripts/
│   │   ├── sync-from-main.js  ← build step: root HTML → www/index.html
│   │   └── setup.sh           ← auto-installs Xcode CLT, Homebrew, Node, CocoaPods
│   ├── ios/                   ← Xcode project (generated by `cap add ios`)
│   └── README.md              ← build + App Store submission guide
├── .github/workflows/ios-sync.yml   ← auto-syncs www/ on push to main/master/dev
└── wiki/
```

**Golden rule**: edit `well-testing-app.html`. The iOS app is a thin wrapper; `www/index.html`
is regenerated. The GitHub Action handles the sync automatically on push.

---

## Calculation fixes (audit batch)

### C1 — Gas choke (calcChoke, dual-choke path)

**Problem**: The gas branch was using a liquid-style equation that ignored pressure ratio,
compressibility, and critical-flow behaviour. Output was off by ~30-50%.

**Fix**: Rewrote the gas branch to Thornhill-Craver / Economides form:
```
q[MSCF/D] = 879.77·Cd·A·P1·√( (k/(k-1))·(r^(2/k) − r^((k+1)/k)) / (SG·T·Z) )
```
with `r = max(P2/P1, r_crit)` where `r_crit = (2/(k+1))^(k/(k-1))`, Sutton pseudocriticals,
and Papay Z-factor at upstream conditions. Verified against textbook worked example
(32/64" @ 3000 psig → 10.71 MMSCFD critical flow).

File: `well-testing-app.html:~1748-1761`

### C2 — Orifice meter (calcOilGas, AGA-3 path)

**Problem**: Used a fixed discharge coefficient and no Reynolds-dependent iteration, so
readings drifted from AGA-3 reference by several percent at extreme beta / Re.

**Fix**: Full Reader-Harris/Gallagher Cd correlation with a 5-iteration Reynolds loop and
the AGA-3 constant 338.178. Matches ISO 5167-2 / API MPMS 14.3.1 to <0.1%.

File: `well-testing-app.html:~5454-5483`

### C3 — Solution GOR (calcSolGOR, Standing 1947)

**Problem**: Formula grouped terms incorrectly; result was off by a factor that grew with
pressure.

**Fix**: Corrected grouping:
```
Rs = γg · [ (P_psia/18.2 + 1.4) · 10^(0.0125·API − 0.00091·T) ]^1.2048
```

File: `well-testing-app.html:~5383`

---

## Well Test Simulator (WTS)

### Build
Full flow tree: Wellhead → **SSV** → Choke → Heater → Separator → Flare, with side
branches Separator → Surge Tank → **Atmospheric Tank**. Each node calculates its own
P, T, velocity from the upstream conditions and line geometry.

### Pipe sizing input
Added wellhead pipeline size input so upstream velocity check uses the actual flowline ID
rather than assuming choke bore.

### Choke → downstream coupling
Previously only choke size changed. Now the downstream nodes recalculate:
- P2 via Thornhill-Craver back-solve (bisection on pressure ratio under fixed q)
- T2 via Joule-Thomson estimate `ΔT ≈ μ_JT · ΔP` with μ_JT ~ 7 °F/100 psi for gas
- V via actual gas volume at P2,T2 through downstream ID
- Erosional check: `V_e = C/√ρ` (API RP 14E, C=100 continuous / 125 intermittent)

### Atmospheric tank branch
Surge tank overflow now routes to a second tank held at atmospheric pressure, with its own
line sizing and velocity readout.

### Node added: SSV
Surface Safety Valve shown upstream of choke, downstream of wellhead. No pressure drop in
normal operation — it's an annunciator node.

---

## Flare simulator — 2D / 3D touch support

**Problem**: Canvases were mouse-only; pinch-zoom and drag didn't work on iPad/iPhone.

**Fix**: Added `touchstart`/`move`/`end`/`cancel` listeners to both flare canvases, with
`{passive:false}` + `preventDefault()` to stop the page scrolling while dragging. Single
finger drags; two fingers pinch-zoom via `Math.hypot(dx, dy)` distance delta.

Also changed `canvas { touch-action: manipulation }` → `touch-action: none` in
`ios-styles.css` so JS owns the gesture instead of the browser consuming it.

2D canvas also got tap-to-mark and double-tap-to-clear for radiation contour drops.

---

## iOS app

### Architecture
Capacitor 6 wrapper around the existing HTML app. No code fork — `scripts/sync-from-main.js`
reads the root HTML and injects three iOS-only additions:

1. **ios-meta.html** → after `<meta name="viewport">`: status-bar style, web-app-capable.
2. **ios-styles.css** → inside the existing `<style>` block: safe-area-inset padding on
   `.sidebar`/`.main`/`#pgBody`, `touch-action:none` on canvas, 16px inputs (kills iOS zoom).
3. **ios-bridge.js** → inside the main IIFE before `})();`: haptics, native share, PDF
   override, Preferences mirror, status bar.

Then copies bundled libs (`jspdf.umd.min.js`, `html2canvas.min.js`) into `www/`.

### Auto-sync from `master` → `www/`
`.github/workflows/ios-sync.yml` triggers on push to `main`/`master`/`dev` when any of:
- `well-testing-app.html`
- `ios-app/ios-additions/**`
- `ios-app/scripts/sync-from-main.js`

...changes. It runs the sync script and commits the new `www/index.html` back with
`[skip ci]` so the commit doesn't re-trigger itself.

### Native bridge (ios-bridge.js)
- **Haptics** — medium impact on buttons whose label starts with "calculate", light on
  everything else.
- **Native save/share** — intercepts `<a download>` clicks. `data:` URLs decoded inline;
  `blob:` URLs fetched and converted to base64 via `FileReader.readAsDataURL`. Then
  `Filesystem.writeFile({directory:'CACHE'})` + `Share.share({url: res.uri})` shows the
  native share sheet (Save to Files, Mail, Print, etc).
- **Exposed** `window.iosSaveFile(name, b64OrText, isBase64)` for any code that wants to
  bypass the `<a download>` pattern.
- **PDF export** — overrides `window.exportReport(title, html)`: renders the report into an
  off-screen 794×1123 iframe, `html2canvas` at 2× scale → PNG → jsPDF A4 multi-page PDF →
  base64 → `writeAndShare()`. Falls back to the original `exportReport` if anything throws.
- **Status bar** — dark style, `#0d1117` background.
- **App lifecycle** — fires `app-backgrounded` DOM event when `appStateChange` goes inactive.
- **Preferences mirror** — every `localStorage.setItem` also writes to Capacitor
  `Preferences` (iCloud-backup-eligible).
- **Pinch lock** — `gesturestart` preventDefault to stop Safari's built-in pinch zoom.

---

## iOS fixes (chronological)

### Black screen on first launch
**Cause**: my initial CSS had `html, body { position: fixed; height: 100% }`, which
collided with the existing `body { display: flex }` layout — nothing painted.
**Fix**: removed the position/size overrides. Safe-area handling now lives on
`.sidebar` / `.main` / `#pgBody` only. `html, body` just get `overscroll-behavior: none`.

### PDF / PNG / CSV exports not saving on device
**Cause**: original bridge used `atob()` + `Blob()` which corrupts binary on iOS WKWebView.
**Fix**: pass base64 straight to `Filesystem.writeFile` with no decoding; iOS writes it
to the app cache as a real file, then `Share.share({url: res.uri})` opens the native
share sheet. Works for any `<a download>` click in the app, no per-calculator changes
needed.

### PDF export was just window.print (unreliable in WKWebView)
**Cause**: the web version's `exportReport` calls `window.print`. That opens the system
print dialog on iOS but doesn't produce a file you can Save to Files / email.
**Fix**: bundled `jspdf.umd.min.js` (358 KB) and `html2canvas.min.js` (195 KB) into
`ios-additions/libs/`; sync script copies them next to `index.html`. On native, the bridge
overrides `window.exportReport` with a real PDF generator. Falls back to print if the
libraries fail to load.

### Flare 3D canvas unmovable on touch
See "Flare simulator — 2D / 3D touch support" above.

### `xcode-select: error: tool 'xcodebuild' requires Xcode, but active directory ...`
**Cause**: user's `xcode-select` was pointing at `/Library/Developer/CommandLineTools`
instead of a full Xcode.app install.
**Fix**: `setup.sh` detects this and runs
`sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer` after prompting.

### `Could not find installation of TypeScript`
**Cause**: `capacitor.config.ts` forced Capacitor to load TypeScript at CLI time.
**Fix**: converted to `capacitor.config.json` (no TS runtime dependency).

### `node: command not found`
**Fix**: `setup.sh` auto-installs Homebrew → Node → CocoaPods if missing. Handles both
Apple Silicon (`/opt/homebrew`) and Intel (`/usr/local`) prefixes via `brew shellenv`.

---

## Branch conventions

- `master` — stable, iOS sync source. Do not commit directly.
- `dev` — active development target. All edits land here; merged to `master` via PR.
- Old `claude/**` branches are retired. Workflow path filter updated accordingly.

---

## App Store submission (abridged)

From `ios-app/README.md`:

Capabilities required in App ID (App Store Connect → Certificates, Identifiers & Profiles):
- None beyond the defaults. No push, no HealthKit, no background modes.

Archive flow: Xcode → Product → Scheme → "Any iOS Device (arm64)" → Product → Archive →
Distribute App → App Store Connect → Upload. No entitlement surprises because we only
use Filesystem (cache dir), Share, Haptics, StatusBar, Preferences, App lifecycle.

Privacy: no data leaves the device. `NSUserTrackingUsageDescription` not required. Declare
"Data Not Collected" in the App Privacy form.

---

## Useful commands

```bash
# Regenerate www/ locally (optional; GH Action does this on push)
cd ios-app && npm run sync-main

# Full iOS build
cd ios-app && npm run build && npx cap sync ios && npx cap open ios

# One-shot setup on a fresh Mac
cd ios-app && bash scripts/setup.sh
```
