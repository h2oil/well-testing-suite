#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# fix-xcode-cloud.sh
#
# Xcode Cloud workflows live in App Store Connect, not in git — so
# there's no file for us to edit. What this script DOES do:
#
#   1. Verify the ios/ folder is present, sync'd, and has the
#      Cap 8 / SPM project structure (App.xcodeproj, no .xcworkspace).
#   2. Pre-resolve SPM packages so the workflow creator doesn't stall.
#   3. Mirror the Xcode Cloud CI scripts into ios/App/ci_scripts/.
#   4. Open Xcode at the .xcodeproj (triggers Apple's workflow
#      editor to pick the right container path — this is how we fix
#      the "Workspace App.xcworkspace does not exist" error).
#   5. Attempt to trigger the "Create Workflow" menu item via
#      AppleScript. If Accessibility permissions aren't granted,
#      falls back to printed step-by-step instructions.
#
# Prerequisites:
#   - The ios/ folder must exist (run scripts/setup.sh first).
#   - Xcode 16+ signed into the Apple Developer account that owns
#     the App Store Connect record for this app.
#   - You must have logged into your Apple ID in App Store Connect
#     at least once (Xcode Cloud uses the signed-in ID to bind the
#     workflow to a product).
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/.."   # → ios-app/

# ─── Output helpers ───
if [ -t 1 ]; then
    BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
    BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi
info()  { printf '%s→ %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()    { printf '%s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn()  { printf '%s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
err()   { printf '%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; }

# ─── 1. Verify project structure ───
info "Verifying Cap 8 + SPM project structure..."

PROJECT="ios/App/App.xcodeproj"
WORKSPACE="ios/App/App.xcworkspace"

if [ ! -d "ios" ]; then
    err "ios/ folder missing."
    echo "  Run: bash scripts/setup.sh"
    exit 1
fi

if [ ! -d "$PROJECT" ]; then
    err "$PROJECT does not exist."
    echo "  Run: bash scripts/setup.sh   (or: npx cap add ios)"
    exit 1
fi
ok "Found $PROJECT"

if [ -d "$WORKSPACE" ]; then
    warn "Legacy $WORKSPACE exists alongside $PROJECT."
    echo "  Under Capacitor 8 + SPM we use the .xcodeproj directly."
    echo "  The .xcworkspace is harmless — Xcode Cloud just needs to point"
    echo "  at the .xcodeproj regardless."
else
    ok "No legacy .xcworkspace (correct for Cap 8 + SPM)"
fi

# ─── 2. Regenerate web assets so the build has latest www/ ───
info "Syncing web assets from main HTML..."
npm run sync-main --silent
npx cap sync ios --quiet >/dev/null 2>&1 || npx cap sync ios

# ─── 3. Pre-resolve SPM packages (avoids a 60s stall in Xcode on first open) ───
info "Pre-resolving Swift Package Manager dependencies..."
xcodebuild -resolvePackageDependencies \
    -project "$PROJECT" \
    -scheme App 2>&1 \
    | grep -E "(Resolved|Resolving|Fetching|error:)" \
    | tail -20 || true

# ─── 4. Install / refresh the Xcode Cloud CI scripts ───
info "Installing Xcode Cloud CI scripts into ios/App/ci_scripts/..."
bash scripts/install-xcodecloud-scripts.sh

# ─── 5. Open Xcode at the correct container ───
info "Opening $PROJECT in Xcode..."
open "$PROJECT"

# Give Xcode time to fully load the project and index
sleep 4

# ─── 6. Try to drive Xcode's "Create Workflow" menu via AppleScript ───
# This only works if the user has granted Accessibility permission to
# Script Editor / osascript in System Settings → Privacy & Security.
# If it fails, we fall through to printed instructions, which is fine —
# the user can click the same menu path themselves.
info "Attempting to open the 'Create Workflow' wizard automatically..."
set +e
osascript 2>/dev/null <<'AS'
tell application "Xcode" to activate
delay 1
tell application "System Events"
    tell process "Xcode"
        click menu item "Create Workflow…" of menu 1 of menu item "Xcode Cloud" of menu 1 of menu bar item "Product" of menu bar 1
    end tell
end tell
AS
AUTOMATION_EXIT=$?
set -e

if [ $AUTOMATION_EXIT -eq 0 ]; then
    ok "Workflow wizard opened"
else
    warn "Could not auto-open the wizard (usually: Accessibility permission)."
    echo "  Trigger it manually:  Product → Xcode Cloud → Create Workflow…"
fi

# ─── 7. Print explicit step-by-step instructions ───
cat <<INSTRUCTIONS

${BOLD}${GREEN}Next steps in Xcode (30-60 seconds):${RESET}

  ${BOLD}A. Delete any existing broken workflow${RESET}
     1. Left sidebar → ☁️  Cloud tab
     2. Right-click your existing 'Build & Archive' workflow → Delete
        (Confirm deletion — this only removes the CI config, not any
        existing archives or TestFlight builds.)

  ${BOLD}B. Create a fresh workflow pointing at .xcodeproj${RESET}
     1. Menu: ${BOLD}Product → Xcode Cloud → Create Workflow…${RESET}
        (The script tried to open this for you above.)
     2. Repository: ${BOLD}h2oil/well-testing-suite${RESET}
        (If prompted to install the Xcode Cloud GitHub App, do so
        and grant access to this repo.)
     3. Primary Branch: ${BOLD}master${RESET}
     4. Click ${BOLD}Next${RESET}
     5. In the workflow editor:

        ${DIM}Name:${RESET}            Build & Archive
        ${DIM}Start Conditions:${RESET} Branch Changes → master → Any files changed
        ${DIM}Environment:${RESET}      Xcode 16, macOS latest, Clean: Off
        ${DIM}Actions:${RESET}
           + Archive → Scheme: App → Platform: iOS →
             Deployment Preparation: TestFlight (Internal Testing Only)
        ${DIM}Post-Actions (optional):${RESET}
           + Notify on Failure → your email

     6. Click ${BOLD}Save${RESET}

  ${BOLD}C. First build kicks off immediately${RESET}
     - Expect 15–25 min on the cold cache. Subsequent builds: 5–8 min.
     - ci_post_clone.sh will run automatically and sync the latest
       www/ from well-testing-app.html before the archive step.
     - Watch progress: ☁️  Cloud tab in Xcode → select the run.

${BOLD}${GREEN}Why this fixes the "Workspace App.xcworkspace does not exist" error:${RESET}
  Capacitor 8 + Swift Package Manager doesn't generate a standalone
  .xcworkspace — the .xcodeproj IS the container. The old workflow
  was pointed at a path that doesn't exist in this project layout.
  Recreating the workflow from the .xcodeproj (by opening it above)
  makes Xcode Cloud bind to the correct container automatically.

INSTRUCTIONS
