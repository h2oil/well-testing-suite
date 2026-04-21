#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# install-xcodecloud-scripts.sh
#   Xcode Cloud only scans for CI scripts in the ci_scripts/ folder
#   sitting next to the .xcworkspace file. Our canonical copy lives
#   at ios-app/ci_scripts/ so it's tracked in git even before the
#   native iOS project exists. This script mirrors those scripts
#   into ios/App/ci_scripts/ and makes them executable.
#
#   Run it from the ios-app/ folder:
#       bash scripts/install-xcodecloud-scripts.sh
#
#   setup.sh calls this automatically after `cap add ios`.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/.."   # → ios-app/

SRC="ci_scripts"
DEST="ios/App/ci_scripts"

if [ ! -d "$SRC" ]; then
    echo "✗ source $SRC/ missing — nothing to install" >&2
    exit 1
fi
if [ ! -d "ios/App" ]; then
    echo "✗ ios/App/ does not exist. Run 'npx cap add ios' first." >&2
    exit 1
fi

mkdir -p "$DEST"
cp -f "$SRC"/*.sh "$DEST"/
chmod +x "$DEST"/*.sh

echo "✓ Xcode Cloud scripts installed to $DEST/"
ls -la "$DEST"
