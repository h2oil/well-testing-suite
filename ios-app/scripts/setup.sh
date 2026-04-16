#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# H2Oil Well Testing — iOS App Setup
# ───────────────────────────────────────────────────────────────
# One-command bootstrap on a Mac:
#   bash scripts/setup.sh
# Requires: Node 18+, Xcode, CocoaPods (`sudo gem install cocoapods`)
# ───────────────────────────────────────────────────────────────

set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "✗ Node.js not found. Install from https://nodejs.org"; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo "✗ Xcode not found. Install from App Store"; exit 1; }
command -v pod >/dev/null 2>&1 || { echo "✗ CocoaPods not found. Run: sudo gem install cocoapods"; exit 1; }

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "✗ Node.js 18+ required (found v$NODE_VER)"
    exit 1
fi

echo "→ Installing npm dependencies..."
npm install

echo "→ Syncing web assets from main HTML..."
npm run sync-main

# Add iOS platform only if not already present
if [ ! -d "ios" ]; then
    echo "→ Adding iOS platform..."
    npx cap add ios
else
    echo "→ iOS platform already present, skipping cap add"
fi

echo "→ Installing CocoaPods..."
cd ios/App && pod install && cd ../..

echo "→ Syncing Capacitor..."
npx cap sync ios

echo ""
echo "✓ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Open the Xcode project:"
echo "       npm run open"
echo ""
echo "  2. In Xcode:"
echo "     - Select your signing team (Signing & Capabilities tab)"
echo "     - Set bundle ID: com.h2oil.welltestingsuite"
echo "     - Choose a simulator or connected device"
echo "     - Hit ⌘+R to run"
echo ""
echo "  3. When main HTML updates:"
echo "       npm run build       # syncs and rebuilds"
echo ""
echo "  4. To submit to App Store:"
echo "       bash scripts/release.sh"
