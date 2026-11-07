#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Xcode Cloud — ci_post_clone.sh
# Runs immediately after Xcode Cloud clones the repo, before Swift
# package resolution and the build/archive action. Installs JS deps,
# regenerates www/index.html from the main HTML source, and syncs
# Capacitor so the web assets + native plugins (the local CapApp-SPM
# Swift package) are in place before xcodebuild.
#
# NOTE for maintainers: this script's canonical location is the
# ios-app/ci_scripts/ folder. Xcode Cloud only runs the copy in
# ios/App/ci_scripts/ (next to App.xcodeproj) — keep the two copies
# identical. `bash scripts/install-xcodecloud-scripts.sh` mirrors it.
#
# The iOS app is free and fully unlocked — no in-app purchases and
# no subscription SDK. Dependencies are Capacitor 8 core + plugins only.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

echo "── Xcode Cloud pre-build ──"
echo "CI_PRIMARY_REPOSITORY_PATH = $CI_PRIMARY_REPOSITORY_PATH"

cd "$CI_PRIMARY_REPOSITORY_PATH/ios-app"
echo "Working dir: $(pwd)"

# ── Node ≥ 22 (hard requirement of the Capacitor 8 CLI) ──
# Xcode Cloud runners don't guarantee Node (or a recent one). If it's
# missing or too old, install the keg-only node@22 formula via Homebrew
# (pre-installed on Xcode Cloud) and put it first on PATH.
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
fi
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    echo "Node ${NODE_MAJOR} missing/too old (Capacitor 8 needs >= 22) — installing node@22 via Homebrew…"
    export HOMEBREW_NO_INSTALL_CLEANUP=1
    brew install node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
    hash -r
fi
echo "node $(node -v)   npm $(npm -v)"

# Deterministic install from package-lock.json.
# --ignore-scripts: the only install script in the tree is `sharp`
# (dev-only, pulled in by @capacitor/assets for local icon generation).
# It downloads native libvips binaries and falls back to a node-gyp
# compile — a common source of flaky CI failures — and nothing in this
# CI pipeline needs it.
if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund --ignore-scripts
else
    npm install --no-audit --no-fund --ignore-scripts
fi

# Small, idempotent source fixes to Capacitor plugins that Xcode compiles from
# node_modules (silences known plugin warnings; see scripts/patch-plugins.js).
node scripts/patch-plugins.js

# Regenerate www/index.html from the single-source-of-truth HTML at repo root.
# This is idempotent — if CI has already committed a fresh www/, this is a no-op.
npm run sync-main

# Copy www/ into the iOS app bundle and sync Capacitor plugins.
# Capacitor 8 uses Swift Package Manager — `cap sync ios` regenerates
# ios/App/CapApp-SPM/Package.swift from the plugins in package.json.
# Xcode Cloud then resolves packages from the committed
# App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved.
# No CocoaPods / pod install.
npx cap sync ios

echo "CapApp-SPM package dependencies after cap sync:"
grep -E '\.package\(' ios/App/CapApp-SPM/Package.swift || true

# ── Auto-stamp version + build number from Xcode Cloud's build index ──
# Versioning scheme — the App Store version always matches the app:
#   MARKETING_VERSION       = newest in-app release, RELEASE_NOTES[0].ver in
#                             well-testing-app.html (the same value the label under
#                             the logo shows), e.g. 'v3.1' → 3.1
#   CURRENT_PROJECT_VERSION = ${CI_BUILD_NUMBER}        # build, e.g. 42
# Each Xcode Cloud run gets a fresh, monotonically increasing CI_BUILD_NUMBER
# from Apple, so every upload is a new build of the current App Store version
# (App Store Connect accepts any number of builds of a version until that version
# is released). Every shipped batch adds a newer release-notes entry (v3.1.1, v3.2 …),
# which raises the App Store version for the next release — Apple rejects a
# version that is not higher than the released one (ITMS-90062).
VERSION_BASE="3.4"   # fallback only, if the release notes cannot be read
APP_HTML="$CI_PRIMARY_REPOSITORY_PATH/well-testing-app.html"
if [ -f "$APP_HTML" ]; then
    RN_VER=$(node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const i=s.indexOf('const RELEASE_NOTES = [');const m=i<0?null:s.slice(i).match(/ver\s*:\s*'v?([0-9]+(?:\.[0-9]+){1,2})'/);process.stdout.write(m?m[1]:'')" "$APP_HTML" 2>/dev/null || true)
    if [ -n "${RN_VER:-}" ]; then
        VERSION_BASE="$RN_VER"
        echo "App Store version from the newest release notes entry: $VERSION_BASE"
    else
        echo "warning: could not read RELEASE_NOTES[0].ver — using fallback $VERSION_BASE"
    fi
fi
PBXPROJ="$CI_PRIMARY_REPOSITORY_PATH/ios-app/ios/App/App.xcodeproj/project.pbxproj"
if [ -n "${CI_BUILD_NUMBER:-}" ] && [ -f "$PBXPROJ" ]; then
    FULL_VERSION="${VERSION_BASE}"
    echo "Stamping version ${FULL_VERSION} (build ${CI_BUILD_NUMBER}) into project.pbxproj..."
    # Escape any slashes/dots safely for sed (none expected in numeric values,
    # but defensive). BSD sed (macOS) requires the empty -i argument.
    sed -i '' -E "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = ${FULL_VERSION};/g" "$PBXPROJ"
    sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = ${CI_BUILD_NUMBER};/g" "$PBXPROJ"
    echo "Verification:"
    grep -E "MARKETING_VERSION|CURRENT_PROJECT_VERSION" "$PBXPROJ" | head -4 || true
else
    echo "CI_BUILD_NUMBER not set or pbxproj missing — leaving committed values in place"
fi

echo "── Pre-build sync complete ──"
