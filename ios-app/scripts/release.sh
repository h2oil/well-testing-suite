#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# H2Oil Well Testing — iOS Release Build
# ───────────────────────────────────────────────────────────────
# Produces an archive ready for App Store submission.
# Run from the ios-app/ directory:
#   bash scripts/release.sh
# ───────────────────────────────────────────────────────────────

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Sync latest HTML from main
echo "→ Syncing from main HTML..."
npm run sync-main
npx cap sync ios

# 2. Archive via xcodebuild
SCHEME="App"
CONFIG="Release"
ARCHIVE_PATH="build/H2Oil-WellTesting.xcarchive"
EXPORT_PATH="build/export"

echo "→ Archiving release build..."
rm -rf build/
mkdir -p build/

xcodebuild -project ios/App/App.xcodeproj \
    -scheme "$SCHEME" \
    -configuration "$CONFIG" \
    -destination "generic/platform=iOS" \
    -archivePath "$ARCHIVE_PATH" \
    archive

# 3. Export options plist (configure as needed)
cat > build/ExportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
    <key>destination</key>
    <string>export</string>
    <key>signingStyle</key>
    <string>automatic</string>
</dict>
</plist>
EOF

# 4. Export .ipa
echo "→ Exporting .ipa..."
xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist build/ExportOptions.plist

IPA_FILE=$(ls "$EXPORT_PATH"/*.ipa 2>/dev/null | head -1 || echo "")
if [ -z "$IPA_FILE" ]; then
    echo "✗ No .ipa produced. Check Xcode errors above."
    exit 1
fi

echo ""
echo "✓ Release build complete!"
echo "  IPA: $IPA_FILE"
echo ""
echo "Next: upload via one of:"
echo "  • Xcode Organizer (recommended):"
echo "      Window → Organizer → select archive → Distribute App → App Store Connect"
echo "  • Transporter.app (drag the .ipa):"
echo "      https://apps.apple.com/app/transporter/id1450874784"
echo "  • altool CLI:"
echo "      xcrun altool --upload-app -f \"$IPA_FILE\" -t ios -u <apple-id> -p <app-password>"
