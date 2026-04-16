#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# H2Oil Well Testing — iOS App Setup (auto-installing)
# ───────────────────────────────────────────────────────────────
# Run this once on your Mac:
#   bash scripts/setup.sh
#
# Auto-installs missing prerequisites (with your confirmation):
#   - Homebrew (if missing)
#   - Node.js (via brew)
#   - CocoaPods (via brew)
#
# You still need Xcode installed manually — get it from the App Store.
# ───────────────────────────────────────────────────────────────

set -euo pipefail

cd "$(dirname "$0")/.."

# ─── Output helpers ───
if [ -t 1 ]; then
    BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
    BOLD=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi
info()  { printf '%s→ %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()    { printf '%s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn()  { printf '%s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
err()   { printf '%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; }

confirm() {
    local msg="$1"
    local yn
    while true; do
        printf '%s [Y/n] ' "$msg"
        read -r yn
        case "${yn:-Y}" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
        esac
    done
}

# ─── 1. macOS check ───
if [[ "${OSTYPE:-}" != "darwin"* ]]; then
    err "This script is for macOS only (iOS builds require Xcode)."
    exit 1
fi

# ─── 2. Xcode (cannot auto-install — Apple requires App Store) ───
info "Checking Xcode..."
if ! command -v xcodebuild >/dev/null 2>&1; then
    err "Xcode not found."
    echo ""
    echo "Xcode must be installed from the Mac App Store (it's ~7 GB):"
    echo "  open 'macappstore://apps.apple.com/app/xcode/id497799835'"
    echo ""
    echo "After installing, accept the license and re-run this script:"
    echo "  sudo xcodebuild -license accept"
    exit 1
fi
ok "Xcode $(xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}')"

# ─── Xcode Command Line Tools ───
if ! xcode-select -p >/dev/null 2>&1; then
    warn "Xcode Command Line Tools not installed."
    if confirm "Install them now? (a system dialog will open)"; then
        xcode-select --install 2>/dev/null || true
        echo ""
        warn "Complete the install dialog, then re-run this script."
        exit 1
    else
        exit 1
    fi
fi

# ─── 3. Homebrew (auto-install if missing) ───
if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not installed."
    echo "Homebrew makes installing Node.js and CocoaPods much easier."
    echo "It's the standard package manager for macOS developers."
    if confirm "Install Homebrew now? (needs your password once)"; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add brew to PATH for this session (Apple Silicon vs Intel)
        if [[ -x /opt/homebrew/bin/brew ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [[ -x /usr/local/bin/brew ]]; then
            eval "$(/usr/local/bin/brew shellenv)"
        fi
    else
        err "Cannot auto-install prerequisites without Homebrew."
        echo "Either install Homebrew from https://brew.sh or install Node.js + CocoaPods manually:"
        echo "  Node:       https://nodejs.org (download LTS installer)"
        echo "  CocoaPods:  sudo gem install cocoapods"
        exit 1
    fi
fi
ok "Homebrew $(brew --version 2>/dev/null | head -1 | awk '{print $2}')"

# ─── 4. Node.js (install or upgrade via brew) ───
info "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
    warn "Node.js not found."
    if confirm "Install Node.js LTS via Homebrew?"; then
        brew install node
    else
        err "Node.js 18+ required. Install manually from https://nodejs.org"
        exit 1
    fi
fi

NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ "${NODE_VER:-0}" -lt 18 ]; then
    warn "Node.js v${NODE_VER} is too old — need 18+."
    if confirm "Upgrade via Homebrew?"; then
        brew upgrade node || brew install node
    else
        err "Node 18+ required."
        exit 1
    fi
fi
ok "Node.js $(node -v)"

# ─── 5. CocoaPods (install via brew — cleaner than sudo gem) ───
info "Checking CocoaPods..."
if ! command -v pod >/dev/null 2>&1; then
    warn "CocoaPods not found."
    if confirm "Install CocoaPods via Homebrew?"; then
        brew install cocoapods
    else
        err "CocoaPods required. Run: brew install cocoapods"
        exit 1
    fi
fi
ok "CocoaPods $(pod --version 2>/dev/null)"

# ─── 6. npm dependencies ───
info "Installing npm dependencies..."
npm install --silent

# ─── 7. Sync web assets from root HTML ───
info "Syncing web assets from main HTML..."
npm run sync-main

# ─── 8. Add iOS platform if not present ───
if [ ! -d "ios" ]; then
    info "Adding iOS platform (generating Xcode project)..."
    npx cap add ios
else
    info "iOS platform already present, skipping cap add"
fi

# ─── 9. CocoaPods install ───
info "Installing CocoaPods dependencies..."
(cd ios/App && pod install --silent)

# ─── 10. Capacitor sync ───
info "Syncing Capacitor..."
npx cap sync ios

# ─── 11. Open Xcode ───
echo ""
ok "Setup complete!"
echo ""
info "Opening Xcode project..."
open ios/App/App.xcworkspace

echo ""
echo "${BOLD}Next steps in Xcode:${RESET}"
echo "  1. Select the ${BOLD}App${RESET} target (left sidebar)"
echo "  2. ${BOLD}Signing & Capabilities${RESET} tab → choose your Team"
echo "  3. Top bar: pick a simulator (e.g., iPhone 15 Pro)"
echo "  4. Hit ${BOLD}⌘+R${RESET} to run"
echo ""
echo "${BOLD}Daily workflow after this:${RESET}"
echo "  • Edit well-testing-app.html anywhere → push to git"
echo "  • GitHub Action auto-syncs the iOS www/"
echo "  • git pull in Xcode → ⌘+R → updated app"
echo ""
echo "${BOLD}To rebuild iOS locally (if not using CI):${RESET}"
echo "  cd ios-app && npm run build"
echo ""
echo "${BOLD}To create an App Store build:${RESET}"
echo "  bash scripts/release.sh"
