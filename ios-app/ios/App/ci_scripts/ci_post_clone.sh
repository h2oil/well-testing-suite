#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# Xcode Cloud — ci_post_clone.sh
# Runs immediately after Xcode Cloud clones the repo, before the
# build/archive action. Regenerates www/index.html from the main
# HTML source, installs JS dependencies, and syncs Capacitor so
# the web assets + native plugins are in place before xcodebuild.
#
# NOTE for maintainers: this script's canonical location is the
# ios-app/ci_scripts/ folder. The first time you run
#   npx cap add ios
# you must copy (or symlink) it into ios/App/ci_scripts/ so Xcode
# Cloud can find it — it only scans next to the .xcworkspace.
# There is a copy step in ios-app/scripts/setup.sh that automates
# this.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

echo "── Xcode Cloud pre-build ──"
echo "CI_PRIMARY_REPOSITORY_PATH = $CI_PRIMARY_REPOSITORY_PATH"

cd "$CI_PRIMARY_REPOSITORY_PATH/ios-app"
echo "Working dir: $(pwd)"

# Xcode Cloud runners ship with Node, but don't assume a specific version.
# If node is missing, install via Homebrew (which is pre-installed).
if ! command -v node >/dev/null 2>&1; then
    echo "Node not found — installing via Homebrew…"
    brew install node
fi
echo "node $(node -v)   npm $(npm -v)"

# Deterministic install — uses package-lock.json if present, else package.json.
if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
else
    npm install --no-audit --no-fund
fi

# Regenerate www/index.html from the single-source-of-truth HTML at repo root.
# This is idempotent — if CI has already committed a fresh www/, this is a no-op.
npm run sync-main

# Copy www/ into the iOS app bundle and sync Capacitor plugins.
# Capacitor 8 uses Swift Package Manager — `cap sync ios` updates the
# Package.swift manifest; Xcode Cloud resolves packages automatically
# before the archive step. No pod install needed.
npx cap sync ios

# ── Auto-stamp version + build number from Xcode Cloud's build index ──
# Versioning scheme (H2Oil v1.3.x line):
#   MARKETING_VERSION       = 1.3.${CI_BUILD_NUMBER}    # e.g. 1.3.42
#   CURRENT_PROJECT_VERSION = ${CI_BUILD_NUMBER}        # e.g. 42
# Each Xcode Cloud run gets a fresh, monotonically increasing
# CI_BUILD_NUMBER from Apple. Since MARKETING_VERSION changes on every
# build, every upload is its own "version train" and Apple won't reject
# with ITMS-90186 or ITMS-90062 even if prior build numbers were higher.
# No manual version bumps required — every commit → push → fresh upload.
VERSION_BASE="1.3"
PBXPROJ="$CI_PRIMARY_REPOSITORY_PATH/ios-app/ios/App/App.xcodeproj/project.pbxproj"
if [ -n "${CI_BUILD_NUMBER:-}" ] && [ -f "$PBXPROJ" ]; then
    FULL_VERSION="${VERSION_BASE}.${CI_BUILD_NUMBER}"
    echo "Stamping version ${FULL_VERSION} (build ${CI_BUILD_NUMBER}) into project.pbxproj..."
    # Escape any slashes/dots safely for sed (none expected in numeric values,
    # but defensive). BSD sed (macOS) requires the empty -i argument.
    sed -i '' -E "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = ${FULL_VERSION};/g" "$PBXPROJ"
    sed -i '' -E "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = ${CI_BUILD_NUMBER};/g" "$PBXPROJ"
    echo "Verification:"
    grep -E "MARKETING_VERSION|CURRENT_PROJECT_VERSION" "$PBXPROJ" | head -4
else
    echo "CI_BUILD_NUMBER not set or pbxproj missing — leaving committed values in place"
fi

echo "── Pre-build sync complete ──"
