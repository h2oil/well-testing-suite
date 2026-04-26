# Project Notes — Well Testing Suite

Running log of significant changes, fixes, and architectural decisions. Newest entries on top.
All changes land on `dev`; `master` is the stable tree consumed by the iOS sync workflow.

---

## 2026-04-26 — PRiSM module: 21-file build, 45 type-curve models, ~32k LOC

Cumulative session work across 6 commits on `Dev`. Brings the PRiSM Well Test
Analysis module up to feature parity with established commercial WTA workstations
(Saphir / F.A.S.T. / KAPPA tier) while keeping the zero-dependency single-HTML-
file architecture intact.

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

## v1.3 — Remove HTML fallback paywall; RC native paywall is sole gate

**Why**: once the RevenueCat dashboard was fully configured (product +
entitlement + offering + published paywall) and the native RC paywall
was verified working end-to-end with sandbox StoreKit, the HTML
fallback became dead weight. It existed to cover the RC misconfig
transition period — with that behind us, it's just extra code and a
UX inconsistency (users who swiped down the native paywall would land
on the less-polished HTML one).

**Removed**
- `ios-app/ios-additions/ios-paywall.html` (67 lines)
- `ios-app/ios-additions/ios-paywall.css` (149 lines)
- From `ios-subscriptions.js`: showFallbackPaywall, hideFallbackPaywall,
  setFallbackStatus, setFallbackButtonsEnabled, refreshFallbackPricingLabel,
  purchaseViaFallback, restoreViaFallback, wireFallbackButtons — about
  115 lines. evaluateGate simplified accordingly.
- From `scripts/sync-from-main.js`: the ios-paywall.css CSS injection
  and the ios-paywall.html DOM injection before `</body>`.
- From `getFlameParams` / results table: unchanged; this is purely
  subscription code.

**Tradeoff** — if RC's CDN hiccups or the SDK fails at runtime
(network loss right at launch, future RC bug, dashboard config
regression) the gate logs an error to the console and stays closed
pending the next visibility change. No emergency subscribe UI is
shown. Acceptable because:
- The gate re-fires on every app foreground, so recovery is automatic
  once connectivity / dashboard returns
- Developers see a prominent console.error in Safari Web Inspector
- Shipping without the fallback matches most production
  RC-integrated apps

**Version bumps**
- App version: `1.2.0` → `1.3.0` (package.json + sidebar brand)
- No Capacitor or RevenueCat version changes

**Follow-on on Mac**
```bash
git pull origin master
cd ios-app
npx cap sync ios
# In Xcode: Product → Clean Build Folder, ⌘R, delete app on device
# first to force a fresh bundle install
```

---

## v1.2 — Capacitor 8 + RevenueCat 13 upgrade

**Why**: RevenueCat 12.x+ requires Capacitor 8, and 10.x / 11.x were
starting to hit podspec conflicts on modern iOS toolchains. Jumping to
the top of both trees in one go — latest 8.3.1 Capacitor and 13.0.1
RevenueCat — trades one migration pain for zero future drift.

**Version bumps**
- App version: `1.1.0` → `1.2.0` (`package.json`, sidebar brand in
  `well-testing-app.html`, matching bump in Xcode target)
- `@capacitor/core` + `@capacitor/ios`: `^7.0.0` → `^8.3.1`
- `@capacitor/cli`: `^7.0.0` → `^8.3.1`
- Capacitor plugins: all bumped to their latest 8.x
  - `@capacitor/app` → `^8.1.0`
  - `@capacitor/haptics` → `^8.0.2`
  - `@capacitor/share` → `^8.0.1`
  - `@capacitor/filesystem` → `^8.1.2`
  - `@capacitor/status-bar` → `^8.0.2`
  - `@capacitor/splash-screen` → `^8.0.1`
  - `@capacitor/preferences` → `^8.0.1`
- `@capacitor/assets`: held at `^3.0.5` (no v4 on npm)
- `@revenuecat/purchases-capacitor` + `@revenuecat/purchases-capacitor-ui`:
  `^11.3.2` → `^13.0.1`

**Hard requirements on the Mac dev box (unchanged from v1.1 except
deployment target)**
- Xcode `16.0+`
- Node `20+`
- CocoaPods current (`pod --version` ≥ 1.15)
- iOS deployment target raised `14.0` → `15.1` (automatic via
  `cap migrate`; RevenueCat 13 paywall UI requires it)

**Capacitor 8 changes that apply to this project**
- iOS deployment target 14.0 → 15.1 (automatic via `cap migrate`)
- Swift 6 concurrency — transparent for our plugin usage
- Minimum Node 20 (was 18 in Cap 7) — we already set 20 in setup.sh
- No plugin API changes affect our code

**Migration procedure (run on Mac)**
```bash
cd ~/well-testing-suite
git pull origin master
cd ios-app

# 1. Fresh deps (picks up Capacitor 8 + RC 13.0.1)
rm -rf node_modules package-lock.json
npm install

# 2. Migrate native project (Podfile deployment target → 15.1, pbxproj)
npx cap migrate

# 3. Reinstall pods
cd ios/App
rm -f Podfile.lock
pod repo update
pod install
cd ../..

# 4. Sync + open Xcode
npm run build
npm run open
```

In Xcode bump version: target App → General → Identity → Version: `1.2`,
Build: increment.

**Rollback plan if anything breaks**
Revert the `package.json` + `PROJECT-NOTES.md` diffs, delete `node_modules`
+ `package-lock.json` + `ios/App/Podfile.lock`, `npm install`, `cap sync`,
`pod install`. The Podfile's platform target might need manual revert to
`14.0` if you're going back past Cap 8.

---

## v1.1 — Capacitor 7 + RevenueCat 10 upgrade

**Why**: RevenueCat's paywall editor requires `purchases-capacitor@^10.3.3`,
which has a peer dependency of `@capacitor/core: ">=7.0.0"`. To unlock the
native paywall editor (and Customer Center UI), the whole stack goes to
Capacitor 7.

**Version bumps**
- App version: `1.0.0` → `1.1.0` (`package.json`, sidebar brand in
  `well-testing-app.html`, needs matching bump in Xcode target)
- `@capacitor/core` + `@capacitor/ios`: `^6.1.2` → `^7.0.0`
- All `@capacitor/*` plugins: `^6.x.x` → `^7.0.0`
- `@capacitor/cli`: `^6.1.2` → `^7.0.0`
- `@capacitor/assets`: `^3.0.5` → `^4.0.0`
- `@revenuecat/purchases-capacitor` + `@revenuecat/purchases-capacitor-ui`:
  `^9.0.0` → `^10.3.3` → `^11.3.2` (latest on the Capacitor-7 line;
  12.x+ needs Capacitor 8)

**Hard requirements on the Mac dev box**
- Xcode `16.0+` (verify: `xcodebuild -version`)
- Node `20+` (verify: `node -v`)
- CocoaPods current (`pod --version` ≥ 1.15)

**Capacitor 7 changes that apply to this project**
- iOS deployment target 13.0 → 14.0 (automatic via `cap migrate`)
- `bundledWebRuntime` config option removed (we never used it)
- No plugin API changes affect our code — Filesystem `directory: 'CACHE'`,
  StatusBar `overlaysWebView: true`, Share, Haptics, Preferences, App, and
  SplashScreen options we use are all still valid
- `capacitor.config.json` needs no edits

**Migration procedure (run on Mac)**
```bash
cd ~/well-testing-suite
git pull origin claude/review-project-errors-x6ZEE
cd ios-app

# 1. Fresh deps (picks up Capacitor 7 + RC 10.3.3)
rm -rf node_modules package-lock.json
npm install

# 2. Let Capacitor migrate the native project (Podfile, deployment target,
#    pbxproj references). This is the big one — it edits the ios/ folder.
npx cap migrate

# 3. Reinstall pods against the Capacitor 7 artefacts
cd ios/App
pod install
cd ../..

# 4. Build the sync output + push to Xcode
npm run build

# 5. Open Xcode, bump the version:
#      Target App → General → Identity → Version: 1.1
#      Build: increment from previous (App Store needs a unique build number)
npm run open
```

**Post-migration checks**
- [ ] Xcode → clean build folder (`⇧⌘K`)
- [ ] Run on simulator — paywall should appear on first launch
- [ ] Safari Web Inspector console shows:
      `[H2Oil iOS] Subscription gate active (RevenueCat + native paywall)`
- [ ] Tick "I am using a supported SDK version" in RevenueCat dashboard
- [ ] Build a paywall in RC dashboard → Paywalls tab on the `default`
      offering → publish → restart app to verify it shows

**Rollback plan if Capacitor 7 breaks something**
Revert the `package.json` diff, delete `node_modules` + `package-lock.json`,
`npm install`, `npx cap sync ios`. The `ios/` folder you'll need to
regenerate or revert from git (`git checkout HEAD -- ios/`).

---

## Subscription — 3-day free trial → $9.99 / month (iOS, via RevenueCat)

**Goal**: Monetise the iOS app via a single auto-renewing subscription tier
with a 3-day free trial. Whole-app gating (no free tier inside the app).
Uses RevenueCat as the entitlement / analytics backend on top of StoreKit.

**Product**
- Product ID: `com.h2oil.welltesting.pro.monthly`
- Subscription group: anything you like (name is for your reference only)
- Price: $9.99 USD / month (configurable per territory in App Store Connect)
- Intro offer: 3-day free trial (one-time, first-time subscribers)
- T&C URL: https://h2oil.sitify.app (must also be set as the EULA in App Store
  Connect → App Information)
- RevenueCat entitlement id: `pro`

**Files added / changed**
- `ios-app/package.json` — added `@revenuecat/purchases-capacitor` +
  `@revenuecat/purchases-capacitor-ui` deps (v9, the last line that still
  supports Capacitor 6; v13+ requires Capacitor 7)
- `ios-app/ios-additions/ios-subscriptions.js` — RevenueCat bridge, offline
  entitlement cache, native paywall + Customer Center wiring, HTML paywall
  fallback, public `window.H2OilSubs` API
- `ios-app/ios-additions/ios-paywall.html` — fallback paywall DOM (used
  only if the native RC paywall can't be shown)
- `ios-app/ios-additions/ios-paywall.css` — full-screen overlay styles
- `ios-app/scripts/sync-from-main.js` — injects paywall HTML/CSS/JS into
  `www/index.html`

**How the gate works**
1. On launch, `ios-subscriptions.js` reads a cached entitlement from
   localStorage (mirrored into Preferences for iCloud backup). If still
   valid (not expired) the app unlocks instantly — works offline for
   existing subscribers.
2. In the background: `Purchases.configure` → `getCustomerInfo`. If the
   `pro` entitlement is active, cache updates and the gate stays open.
3. No entitlement → `RevenueCatUI.presentPaywallIfNeeded` shows the
   native RC paywall (with whatever design was built in the RC dashboard
   Paywalls tab). StoreKit handles the 3-day trial automatically when the
   intro offer is configured.
4. If the UI plugin or the paywall isn't available, we fall through to
   the custom HTML paywall (same Subscribe + Restore + T&C + Privacy
   Policy, just not designed in RC's editor).
5. A small `⚙︎` floating button appears in the corner for subscribers
   and opens `RevenueCatUI.presentCustomerCenter()` — the native cancel
   / change-plan / refund-request flow.
6. `visibilitychange` re-evaluates after returning from the Customer
   Center or from the iOS Settings app.

**Public API** (for wiring buttons in calculators or the sidebar):
```js
await window.H2OilSubs.isEntitled();       // boolean
await window.H2OilSubs.getEntitlement();   // { active, expiry, productId, willRenew, inTrial }
await window.H2OilSubs.presentPaywall();   // show RC paywall on demand
await window.H2OilSubs.presentCustomerCenter();  // manage / cancel
await window.H2OilSubs.refresh();          // re-run the gate check
```

**Required config in code** — in `ios-app/ios-additions/ios-subscriptions.js`
at the top, replace the placeholder API key with the iOS public key from
your RevenueCat dashboard:
```js
const REVENUECAT_API_KEY = 'appl_XXXXXXXXXXXXXXXXXXXXXXXX';
```

**Apple compliance checklist** (avoids 3.1.2 rejection)
- [x] Price shown before purchase CTA
- [x] Duration shown before purchase CTA ("monthly")
- [x] Trial duration and terms shown
- [x] Auto-renewal disclosure present
- [x] Links to EULA (T&C) and Privacy Policy present on paywall
- [x] Restore Purchases button present
- [x] StoreKit used (RevenueCat wraps StoreKit, no external payment)

**Setup — App Store Connect**
1. My Apps → H2Oil → Subscriptions → create subscription group
2. Add subscription:
   - Reference name: `H2Oil Pro Monthly`
   - Product ID: `com.h2oil.welltesting.pro.monthly`
   - Duration: 1 Month
   - Price: Tier matching $9.99 USD
3. Add Introductory Offer → Type: Free, Duration: 3 Days, Eligibility: New
   subscribers
4. Localization — add display name + description (required before review)
5. App Information → set EULA URL to https://h2oil.sitify.app
6. App Privacy → declare "Purchases" data type
7. Review Information → add a sandbox test account

**Setup — RevenueCat dashboard** (https://app.revenuecat.com)
1. Create project → add iOS app → link your App Store Connect shared secret
   (App Store Connect → Users and Access → Keys → In-App Purchase → generate
   shared secret)
2. Entitlements → create entitlement with identifier **`pro`**
   (display name can be "Well Testing Suite Pro")
3. Products → import from App Store Connect (or create manually with id
   `com.h2oil.welltesting.pro.monthly`), attach it to the `pro` entitlement
4. Offerings → create offering with identifier **`default`**, add a Monthly
   package that points to your product
5. **Paywalls** tab (on the `default` offering) → build a paywall with
   RC's visual editor. This is what `presentPaywallIfNeeded` shows. If you
   skip this step, the custom HTML paywall (fallback) is used instead.
6. API Keys → copy the **iOS public key** (starts with `appl_`) and paste
   it into `REVENUECAT_API_KEY` in `ios-subscriptions.js`
7. Customer Center (free, included) — no setup needed. Appears via the
   `⚙︎` button once a user is entitled.

**Why RevenueCat over raw StoreKit**
- Server-side receipt validation (can't be bypassed by jailbroken devices)
- Real-time entitlement revocation (refunds, chargebacks)
- Cross-platform if we add Android later (same `pro` entitlement works)
- Subscription analytics out of the box (MRR, churn, cohorts)
- Free up to $2.5k tracked MRR — effectively free for launch

**Dev helper** — reset cached entitlement in Safari Web Inspector:
```js
window.__h2oilResetEntitlement()
```

**Not included (on purpose)**
- Paywall A/B — RevenueCat supports this via remote offerings but we only
  have one offering right now.
- Multi-tier (monthly + annual) — stick with monthly only until we have
  conversion data.

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
