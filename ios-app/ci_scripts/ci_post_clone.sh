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
# `cap sync ios` also runs `pod install`, so the Pods/ folder is populated
# before Xcode Cloud's archive step.
npx cap sync ios

echo "── Pre-build sync complete ──"
