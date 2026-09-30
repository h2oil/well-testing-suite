#!/usr/bin/env bash
# =============================================================================
# install.sh - installs the WTS Modbus bridge (WebSocket <-> Modbus TCP) for the
# current user on macOS or Linux. No sudo / admin rights are needed for the bridge.
#
#   bash install.sh [--allow 192.168.1.10:502] [--allow '10.0.0.0/24:502,plc.local:*']
#                   [--port 8502] [--listen 127.0.0.1] [--allow-writes | --read-only]
#                   [--origin https://my.site] [--autostart] [--reset]
#                   [--yes] [--no-start] [--uninstall] [--help]
#
# One line, from the GitHub release (the release installer carries the bridge files):
#   curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes
#
# What it does
#   1. Checks for Node.js 18 or newer. If it is missing it offers to install it with the
#      system package manager (brew, apt-get, dnf, yum, pacman or apk) - only after you
#      confirm (or with --yes). Nothing else is downloaded.
#   2. Copies modbus-bridge.js, fake-slave.js and README.md to
#        macOS:  ~/Library/Application Support/WTS Modbus Bridge
#        Linux:  ${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge
#      and writes bridge-config.json and start-bridge.sh there.
#   3. --autostart: a macOS LaunchAgent (~/Library/LaunchAgents/uk.co.h2oil.wts-modbus-bridge.plist)
#      or a Linux systemd --user service (wts-modbus-bridge.service) starts the bridge now and
#      at every login. Without --autostart the bridge runs in this terminal window
#      (Ctrl+C stops it); an existing auto-start bridge is restarted with the new settings.
#   4. Checks http://127.0.0.1:<port>/health and prints the next steps.
#
# Running it again keeps the settings of the existing bridge-config.json: new --allow targets
# are ADDED to its allow list, and its port / listen address / write setting / origins stay
# unless you give --port / --listen / --allow-writes / --read-only. --reset starts from a new,
# empty configuration (the old file is kept as bridge-config.json.bak).
#
# --allow   host:port the bridge may connect to (repeat it, or give a comma list):
#           IPv4 (192.168.1.10:502), IPv4 subnet (10.0.0.0/24:502), host name
#           (plc-1.local:502) or IPv6 in brackets ([fd00::10]:502); port 1-65535 or * (any
#           port). Quote values with * or [ ] ('plc.local:*') - zsh refuses an unmatched glob.
#           With no --allow at all the bridge allows any device IP / port (default).
# --allow-any  allow any device IP / port (same as --allow '*:*').
# --port    WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:<port>).
# --listen  interface to listen on (default 127.0.0.1 = this computer only).
# --allow-writes  forward Modbus write requests (FC 05/06/15/16); --read-only refuses them (default).
# --origin  also accept pages from this origin (https://my.site, or null for a saved file:// copy
#           of the app - any web site can send "null", so only on a PC not used for browsing).
# --no-start      install only; do not start the bridge (with --autostart: it starts at the next login).
# --reset         ignore the existing bridge-config.json and write a new one.
# --uninstall     stop and remove the auto-start entry and the installed files.
# =============================================================================
set -euo pipefail
# The whole script is one { ... } group, so bash reads all of it before running anything: it can
# be piped into bash (curl ... | bash -s -- ...) without a command reading the rest of the script.
{
SELF="${BASH_SOURCE[0]:-}"          # empty when the script is piped into bash

# @@WTS-PRESET-BEGIN@@ (the app's "Generate installer for my devices" fills in this block)
PRESET_ALLOW=""
PRESET_PORT=""
PRESET_LISTEN=""
PRESET_ALLOW_WRITES=""
PRESET_AUTOSTART=""
PRESET_ORIGINS=""
# @@WTS-PRESET-END@@

# @@WTS-PAYLOAD-BEGIN@@ (a generated installer embeds the bridge files here)
EMBEDDED_FILES=""
EMBEDDED_VERSION=""
# @@WTS-PAYLOAD-END@@

APP_NAME="WTS Modbus Bridge"
LABEL="uk.co.h2oil.wts-modbus-bridge"
UNIT_NAME="wts-modbus-bridge.service"
DEFAULT_PORT=8502
NODE_MIN=18
INSTALLED_FILES=(modbus-bridge.js fake-slave.js README.md bridge-config.json bridge-config.json.bak bridge-config.json.tmp start-bridge.sh install.sh bridge.log)

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
    if [ -n "$SELF" ] && [ -f "$SELF" ]; then
        sed -n '2,/^# =====/p' "$SELF" 2>/dev/null | sed -e 's/^# \{0,1\}//' -e '/^=====/d' || true
    else
        say "Options: --allow host:port, --allow-any, --port N, --listen IP, --allow-writes, --read-only, --origin URL,"
        say "         --autostart, --no-start, --reset, --yes, --uninstall (see the README of the WTS Modbus bridge)."
    fi
}

# ---- validation (no shell metacharacters can get through) -------------------
valid_ipv4() {
    local ip="$1" i
    [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    for i in 1 2 3 4; do
        (( 10#${BASH_REMATCH[$i]} <= 255 )) || return 1
    done
    return 0
}
valid_ipv6() {                      # hex digits, colons and dots only (no zone id), 2+ colons
    local a="$1" colons
    [[ "$a" =~ ^[0-9A-Fa-f:.]{2,45}$ ]] || return 1
    colons="${a//[^:]/}"
    [ "${#colons}" -ge 2 ]
}
valid_host() {
    local h="$1" ip bits
    if [ "${#h}" -lt 1 ] || [ "${#h}" -gt 253 ]; then return 1; fi
    if [[ "$h" == \[*\] ]]; then valid_ipv6 "${h:1:${#h}-2}"; return; fi
    if [[ "$h" == */* ]]; then
        ip="${h%/*}"; bits="${h##*/}"
        valid_ipv4 "$ip" || return 1
        [[ "$bits" =~ ^[0-9]{1,2}$ ]] || return 1
        (( 10#$bits <= 32 )) || return 1
        return 0
    fi
    if [[ "$h" =~ ^[0-9.]+$ ]]; then valid_ipv4 "$h"; return; fi
    [[ "$h" =~ ^[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?$ ]] || return 1
    [[ "$h" != *..* ]]
}
valid_port() {
    [[ "$1" =~ ^[0-9]{1,5}$ ]] || return 1
    (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}
valid_target() {
    local t="$1"
    [[ "$t" == *:* ]] || return 1
    if [ "${t%:*}" = "*" ]; then [ "${t##*:}" = "*" ] || valid_port "${t##*:}"; return; fi
    valid_host "${t%:*}" || return 1
    [ "${t##*:}" = "*" ] || valid_port "${t##*:}"
}
norm_target() {                     # a valid target -> lower case, port without leading zeros
    local t h p
    t="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    h="${t%:*}"; p="${t##*:}"
    if [ "$p" != "*" ]; then p=$((10#$p)); fi
    printf '%s:%s' "$h" "$p"
}
valid_listen() {
    [ "$1" = "localhost" ] || valid_ipv4 "$1"
}
norm_listen() {                     # "localhost" may resolve to ::1 only - the app uses 127.0.0.1
    if [ "$1" = "localhost" ]; then printf '127.0.0.1'; else printf '%s' "$1"; fi
}
valid_origin() {                    # null | file:// | http(s)://host[:port]
    local o="$1" re='^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:([0-9]{1,5}))?$'
    case "$o" in null|file://) return 0 ;; esac
    [ "${#o}" -le 300 ] || return 1
    [[ "$o" =~ $re ]] || return 1
    if [ -n "${BASH_REMATCH[3]:-}" ]; then valid_port "${BASH_REMATCH[3]}" || return 1; fi
    return 0
}
in_list() {                         # $1 in the remaining arguments?
    local x="$1" e
    shift
    for e in "$@"; do
        if [ "$e" = "$x" ]; then return 0; fi
    done
    return 1
}

NEW_ALLOW=(); NEW_ORIGINS=()
add_allow() {                       # $1 = one entry or a comma-separated list
    local item parts=()
    IFS=',' read -r -a parts <<< "$1"
    for item in ${parts[@]+"${parts[@]}"}; do
        item="${item//[[:space:]]/}"
        [ -n "$item" ] || continue
        valid_target "$item" || die "invalid --allow entry '$item' (use ip:port, ip/bits:port, hostname:port or [ipv6]:port; port 1-65535 or *)"
        item="$(norm_target "$item")"
        in_list "$item" ${NEW_ALLOW[@]+"${NEW_ALLOW[@]}"} || NEW_ALLOW+=("$item")
    done
    return 0
}
add_origin() {                      # $1 = one origin or a comma-separated list
    local item parts=()
    IFS=',' read -r -a parts <<< "$1"
    for item in ${parts[@]+"${parts[@]}"}; do
        item="${item//[[:space:]]/}"
        [ -n "$item" ] || continue
        valid_origin "$item" || die "invalid --origin '$item' (use https://host[:port], http://host[:port], null or file://)"
        in_list "$item" ${NEW_ORIGINS[@]+"${NEW_ORIGINS[@]}"} || NEW_ORIGINS+=("$item")
    done
    return 0
}

# ---- arguments ----------------------------------------------------------------
CLI_PORT=""; CLI_LISTEN=""; CLI_WRITES=""; AUTOSTART=0; UNINSTALL=0; ASSUME_YES=0; NO_START=0; RESET=0
if [ -n "$PRESET_ALLOW" ]; then add_allow "$PRESET_ALLOW"; fi
if [ -n "$PRESET_ORIGINS" ]; then add_origin "$PRESET_ORIGINS"; fi
if [ "$PRESET_AUTOSTART" = "1" ]; then AUTOSTART=1; fi
while [ $# -gt 0 ]; do
    case "$1" in
        --allow)        [ $# -ge 2 ] || die "--allow needs host:port"; add_allow "$2"; shift 2 ;;
        --allow=*)      add_allow "${1#*=}"; shift ;;
        --origin)       [ $# -ge 2 ] || die "--origin needs an origin"; add_origin "$2"; shift 2 ;;
        --origin=*)     add_origin "${1#*=}"; shift ;;
        --port)         [ $# -ge 2 ] || die "--port needs a number"; CLI_PORT="$2"; shift 2 ;;
        --port=*)       CLI_PORT="${1#*=}"; shift ;;
        --listen)       [ $# -ge 2 ] || die "--listen needs an address"; CLI_LISTEN="$2"; shift 2 ;;
        --listen=*)     CLI_LISTEN="${1#*=}"; shift ;;
        --allow-any)    add_allow '*:*'; shift ;;
        --allow-writes) CLI_WRITES=1; shift ;;
        --read-only)    CLI_WRITES=0; shift ;;
        --autostart)    AUTOSTART=1; shift ;;
        --no-start)     NO_START=1; shift ;;
        --reset)        RESET=1; shift ;;
        --uninstall)    UNINSTALL=1; shift ;;
        -y|--yes)       ASSUME_YES=1; shift ;;
        -h|--help)      usage; exit 0 ;;
        *)              die "unknown option '$1' (see: bash install.sh --help)" ;;
    esac
done
if [ -n "$CLI_PORT" ]; then
    valid_port "$CLI_PORT" || die "invalid --port '$CLI_PORT' (1-65535)"
    CLI_PORT=$((10#$CLI_PORT))
fi
if [ -n "$PRESET_PORT" ]; then
    valid_port "$PRESET_PORT" || die "invalid preset port '$PRESET_PORT' (1-65535)"
    PRESET_PORT=$((10#$PRESET_PORT))
fi
if [ -n "$CLI_LISTEN" ]; then
    valid_listen "$CLI_LISTEN" || die "invalid --listen '$CLI_LISTEN' (an IPv4 address or localhost)"
    CLI_LISTEN="$(norm_listen "$CLI_LISTEN")"
fi
if [ -n "$PRESET_LISTEN" ]; then
    valid_listen "$PRESET_LISTEN" || die "invalid preset listen address '$PRESET_LISTEN'"
    PRESET_LISTEN="$(norm_listen "$PRESET_LISTEN")"
fi
case "$PRESET_ALLOW_WRITES" in ""|0|1) ;; *) die "invalid preset PRESET_ALLOW_WRITES '$PRESET_ALLOW_WRITES'" ;; esac
# Until the existing configuration is read (install) - used as they are by --uninstall.
PORT="${CLI_PORT:-${PRESET_PORT:-$DEFAULT_PORT}}"
LISTEN="${CLI_LISTEN:-${PRESET_LISTEN:-127.0.0.1}}"

# ---- where things go -----------------------------------------------------------
[ -n "${HOME:-}" ] || die "HOME is not set"
PLIST=""; UNIT_FILE=""
case "$(uname -s)" in
    Darwin)
        OS=macos
        INSTALL_DIR="$HOME/Library/Application Support/$APP_NAME"
        PLIST="$HOME/Library/LaunchAgents/$LABEL.plist" ;;
    Linux)
        OS=linux
        case "${XDG_DATA_HOME:-}" in /*) DATA_HOME="$XDG_DATA_HOME" ;; *) DATA_HOME="$HOME/.local/share" ;; esac
        case "${XDG_CONFIG_HOME:-}" in /*) CONFIG_HOME="$XDG_CONFIG_HOME" ;; *) CONFIG_HOME="$HOME/.config" ;; esac
        INSTALL_DIR="$DATA_HOME/wts-modbus-bridge"
        UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT_NAME" ;;
    *)
        die "unsupported system '$(uname -s)' - on Windows use install-windows.ps1" ;;
esac
SCRIPT_DIR=""
if [ -n "$SELF" ]; then SCRIPT_DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd)" || SCRIPT_DIR="."; fi
NODE_BIN=""
HEALTH_HOST=""
set_health_host() {
    HEALTH_HOST="$LISTEN"
    if [ "$HEALTH_HOST" = "0.0.0.0" ]; then HEALTH_HOST=127.0.0.1; fi
}
set_health_host

# ---- helpers -------------------------------------------------------------------
confirm() {                         # $1 = question; yes only with --yes or a typed y
    local ans=""
    if [ "$ASSUME_YES" = 1 ]; then return 0; fi
    if [ ! -t 0 ]; then return 1; fi
    printf '%s [y/N] ' "$1"
    read -r ans || return 1
    case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}
node_major() {
    "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0'
}
find_node() {
    local c
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ]; then
        for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
            if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
        done
    fi
    return 0
}
node_ok() {
    local major
    [ -n "$NODE_BIN" ] || return 1
    major="$(node_major "$NODE_BIN")"
    [[ "$major" =~ ^[0-9]+$ ]] || return 1
    [ "$major" -ge "$NODE_MIN" ]
}
node_help() {
    say "Install Node.js $NODE_MIN or newer (the LTS version), then run this installer again:"
    if [ "$OS" = macos ]; then
        say "  - Homebrew:   brew install node"
        say "  - or the macOS installer from https://nodejs.org"
    else
        say "  - your distribution's nodejs package if it is version $NODE_MIN or newer"
        say "    (Debian/Ubuntu: sudo apt-get install nodejs;  Fedora: sudo dnf install nodejs)"
        say "  - or the Linux binaries / package instructions on https://nodejs.org"
    fi
}
ensure_node() {
    local have
    find_node
    if node_ok; then return 0; fi
    if [ -n "$NODE_BIN" ]; then have="version $(node_major "$NODE_BIN") at $NODE_BIN"; else have="not found"; fi
    say "Node.js $NODE_MIN or newer is needed to run the bridge (Node.js: $have)."
    local sudo_cmd=() cmd=()
    if [ "$(id -u)" != "0" ]; then sudo_cmd=(sudo); fi
    if [ "$OS" = macos ]; then
        if command -v brew >/dev/null 2>&1; then cmd=(brew install node); fi
    elif command -v apt-get >/dev/null 2>&1; then cmd=(${sudo_cmd[@]+"${sudo_cmd[@]}"} apt-get install -y nodejs)
    elif command -v dnf >/dev/null 2>&1; then cmd=(${sudo_cmd[@]+"${sudo_cmd[@]}"} dnf install -y nodejs)
    elif command -v yum >/dev/null 2>&1; then cmd=(${sudo_cmd[@]+"${sudo_cmd[@]}"} yum install -y nodejs)
    elif command -v pacman >/dev/null 2>&1; then cmd=(${sudo_cmd[@]+"${sudo_cmd[@]}"} pacman -S --needed --noconfirm nodejs)
    elif command -v apk >/dev/null 2>&1; then cmd=(${sudo_cmd[@]+"${sudo_cmd[@]}"} apk add nodejs)
    fi
    if [ ${#cmd[@]} -eq 0 ]; then node_help; exit 1; fi
    if ! confirm "Install Node.js now with:  ${cmd[*]}  ?"; then node_help; exit 1; fi
    "${cmd[@]}" || { warn "the package manager reported an error"; node_help; exit 1; }
    hash -r 2>/dev/null || true
    find_node
    if ! node_ok; then
        say "The installed Node.js is still older than $NODE_MIN (or not on PATH)."
        node_help
        exit 1
    fi
    return 0
}
sha256_of() {
    "$NODE_BIN" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}
decode_b64_to() {                   # stdin: base64 text; $1: destination file
    "$NODE_BIN" -e 'const fs=require("fs");let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d;});process.stdin.on("end",()=>{fs.writeFileSync(process.argv[1],Buffer.from(s.replace(/[^A-Za-z0-9+\/=]/g,""),"base64"));});' "$1"
}
fetch_health() {                    # prints the /health JSON; fails when nothing answers
    local url="http://$HEALTH_HOST:$PORT/health"
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 2 --noproxy '*' "$url" 2>/dev/null
    elif [ -n "$NODE_BIN" ]; then
        "$NODE_BIN" -e 'const r=require("http").get(process.argv[1],{timeout:2000},(res)=>{let s="";res.on("data",(d)=>{s+=d;});res.on("end",()=>{if(res.statusCode!==200)process.exit(1);process.stdout.write(s);});});r.on("timeout",()=>{r.destroy();process.exit(1);});r.on("error",()=>process.exit(1));' "$url"
    else
        return 1
    fi
}
port_in_use() {                     # anything (a bridge or another program) listening on the port?
    "$NODE_BIN" -e 'const s=require("net").connect({host:process.argv[1],port:+process.argv[2]});s.setTimeout(1500);s.on("connect",()=>{s.destroy();process.exit(0);});s.on("timeout",()=>{s.destroy();process.exit(1);});s.on("error",()=>process.exit(1));' "$HEALTH_HOST" "$PORT"
}
describe_health() {                 # stdin: /health JSON
    "$NODE_BIN" -e 'let s="";process.stdin.on("data",(d)=>{s+=d;});process.stdin.on("end",()=>{try{const h=JSON.parse(s);process.stdout.write("v"+h.version+", "+(h.readOnly?"read-only":"writes ALLOWED")+", port "+h.port+"; allowed targets: "+((h.allow||[]).join(", ")||"(none)"));}catch(e){process.stdout.write("(unexpected reply)");}});'
}
verify_health() {                   # is the bridge that answered the one just configured?
    printf '%s' "$HEALTH_JSON" | "$NODE_BIN" -e '
const a=process.argv.slice(1);const {parseAllow}=require(a[0]);const port=+a[1],readOnly=a[2]!=="1";
const spec=(x)=>{try{return parseAllow(x).spec;}catch(e){return String(x).toLowerCase();}};
const want=a.slice(3).map(spec).sort();let s="";
process.stdin.on("data",(d)=>{s+=d;});
process.stdin.on("end",()=>{let h;try{h=JSON.parse(s);}catch(e){process.exit(1);}
const got=(Array.isArray(h.allow)?h.allow:[]).map((x)=>String(x).toLowerCase()).sort();
process.exit(h.port===port&&h.readOnly===readOnly&&JSON.stringify(got)===JSON.stringify(want)?0:1);});' \
        "$INSTALL_DIR/modbus-bridge.js" "$PORT" "$ALLOW_WRITES" ${ALLOW_LIST[@]+"${ALLOW_LIST[@]}"}
}
wait_health() {                     # $1 = seconds; $2 = pid to watch (optional)
    local tries=$(( $1 * 4 )) json
    while [ "$tries" -gt 0 ]; do
        if json="$(fetch_health)"; then
            HEALTH_JSON="$json"
            return 0
        fi
        if [ -n "${2:-}" ] && ! kill -0 "$2" 2>/dev/null; then return 1; fi
        sleep 0.25
        tries=$(( tries - 1 ))
    done
    return 1
}
xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
systemd_quote() {                   # one ExecStart= argument in double quotes, with \ " $ % escaped
    local s
    # shellcheck disable=SC2016
    s="$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/$$/g' -e 's/%/%%/g')"
    printf '"%s"' "$s"
}
systemd_user_ok() {
    command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}
autostart_installed() {
    if [ "$OS" = macos ]; then [ -f "$PLIST" ]; else [ -f "$UNIT_FILE" ]; fi
}
configured_port() {                 # port from an existing bridge-config.json (for --uninstall)
    local f="$INSTALL_DIR/bridge-config.json" p=""
    if [ -f "$f" ]; then
        p="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -n 1)"
    fi
    if valid_port "${p:-x}"; then printf '%s' "$((10#$p))"; else printf '%s' "$PORT"; fi
}
our_bridge_pids() {                 # this user's bridges running from the install folder
    local js="$INSTALL_DIR/modbus-bridge.js" me uid pid args
    me="$(id -u)"
    { ps -A -ww -o uid= -o pid= -o args= 2>/dev/null || true; } | while read -r uid pid args; do
        if [ "$uid" = "$me" ] && [ "$pid" != "$$" ]; then
            case "$args" in *"$js"*) printf '%s\n' "$pid" ;; esac
        fi
    done
    return 0
}
stop_our_bridges() {                # an earlier foreground install, start-bridge.sh or the auto-start service
    local pids pid n=0 i
    if autostart_installed; then
        if [ "$OS" = macos ]; then
            launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
        elif systemd_user_ok; then
            systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1 || true
        fi
    fi
    pids="$(our_bridge_pids)"
    for pid in $pids; do
        if kill "$pid" 2>/dev/null; then n=$((n + 1)); fi
    done
    if [ "$n" -gt 0 ]; then
        for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
            if [ -z "$(our_bridge_pids)" ]; then break; fi
            sleep 0.25
        done
        say "Stopped $n bridge process(es) started from $INSTALL_DIR"
    fi
    return 0
}

# ---- uninstall -----------------------------------------------------------------
stop_autostart() {
    if [ "$OS" = macos ]; then
        if [ -f "$PLIST" ]; then
            launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
        fi
    elif [ -f "$UNIT_FILE" ] && systemd_user_ok; then
        systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    fi
    return 0
}
do_uninstall() {
    local f removed=0 pid
    PORT="$(configured_port)"
    stop_autostart
    for pid in $(our_bridge_pids); do kill "$pid" 2>/dev/null || true; done
    if [ "$OS" = macos ] && [ -f "$PLIST" ]; then rm -f "$PLIST"; say "Removed the LaunchAgent $PLIST"; fi
    if [ "$OS" = linux ] && [ -f "$UNIT_FILE" ]; then
        rm -f "$UNIT_FILE"; say "Removed the systemd --user service $UNIT_FILE"
        if systemd_user_ok; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
    fi
    if [ -d "$INSTALL_DIR" ]; then
        for f in "${INSTALLED_FILES[@]}"; do
            if [ -e "$INSTALL_DIR/$f" ]; then rm -f "$INSTALL_DIR/$f"; removed=$((removed + 1)); fi
        done
        if rmdir "$INSTALL_DIR" 2>/dev/null; then say "Removed $INSTALL_DIR ($removed files)"
        else warn "$INSTALL_DIR still contains other files - left in place"; fi
    else
        say "Nothing installed in $INSTALL_DIR"
    fi
    find_node
    sleep 0.5
    if fetch_health >/dev/null 2>&1; then
        warn "a bridge still answers on port $PORT (started by hand?) - close its terminal window or press Ctrl+C there."
    fi
    say "The WTS Modbus bridge is uninstalled."
}

if [ "$UNINSTALL" = 1 ]; then do_uninstall; exit 0; fi

# ---- install -------------------------------------------------------------------
ensure_node

# The existing bridge-config.json supplies the defaults, so running the installer again (for
# one more device, or --allow-writes) never drops the other targets or changes the port.
OLD_ALLOW=(); OLD_PORT=""; OLD_LISTEN=""; OLD_WRITES=""; HAVE_OLD=0
read_existing_config() {
    local f="$INSTALL_DIR/bridge-config.json" out key val re='^[][A-Za-z0-9._:/*-]+$'
    [ -f "$f" ] || return 0
    if ! out="$("$NODE_BIN" -e '
const fs=require("fs");let c;
try{c=JSON.parse(fs.readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,""));}catch(e){process.exit(3);}
if(!c||typeof c!=="object"||Array.isArray(c))process.exit(3);
const safe=(s)=>typeof s==="string"&&/^[\x21-\x7e]{1,300}$/.test(s.trim());
(Array.isArray(c.allow)?c.allow:[]).forEach((x)=>console.log(safe(x)?"allow "+x.trim():"bad "+JSON.stringify(x).slice(0,60).replace(/[^\x20-\x7e]/g,"?")));
if(Number.isInteger(c.port))console.log("port "+c.port);
if(safe(c.listen))console.log("listen "+c.listen.trim());
if(typeof c.allowWrites==="boolean")console.log("writes "+(c.allowWrites?1:0));' "$f")"; then
        warn "$f could not be read (not valid JSON?) - writing a new one (the old file is kept as bridge-config.json.bak)."
        return 0
    fi
    HAVE_OLD=1
    while IFS=' ' read -r key val; do
        case "$key" in
            allow)
                if valid_target "$val"; then val="$(norm_target "$val")"
                elif ! [[ "$val" =~ $re ]]; then warn "left out '$val' from the existing allow list (not a host:port target)"; continue; fi
                in_list "$val" ${OLD_ALLOW[@]+"${OLD_ALLOW[@]}"} || OLD_ALLOW+=("$val") ;;
            bad)    warn "left out $val from the existing allow list (not a host:port target)" ;;
            port)   if valid_port "$val"; then OLD_PORT=$((10#$val)); fi ;;
            listen) if valid_listen "$val"; then OLD_LISTEN="$(norm_listen "$val")"; else warn "the existing listen address '$val' is not an IPv4 address or localhost - not kept"; fi ;;
            writes) OLD_WRITES="$val" ;;
        esac
    done <<< "$out"
    return 0
}
if [ "$RESET" != 1 ]; then read_existing_config; fi
ALLOW_LIST=()
for e in ${OLD_ALLOW[@]+"${OLD_ALLOW[@]}"} ${NEW_ALLOW[@]+"${NEW_ALLOW[@]}"}; do
    in_list "$e" ${ALLOW_LIST[@]+"${ALLOW_LIST[@]}"} || ALLOW_LIST+=("$e")
done
PORT="${CLI_PORT:-${PRESET_PORT:-${OLD_PORT:-$DEFAULT_PORT}}}"
LISTEN="${CLI_LISTEN:-${PRESET_LISTEN:-${OLD_LISTEN:-127.0.0.1}}}"
ALLOW_WRITES="${CLI_WRITES:-${PRESET_ALLOW_WRITES:-${OLD_WRITES:-0}}}"
set_health_host
if [ "$HAVE_OLD" = 1 ]; then
    say "Keeping the settings of the existing $INSTALL_DIR/bridge-config.json (${#OLD_ALLOW[@]} target(s); new targets are added - --reset starts a new list)."
fi
if [ ${#ALLOW_LIST[@]} -eq 0 ]; then
    ALLOW_LIST=('*:*')
    say "No --allow targets given: the bridge will allow any device IP / port (default). Give --allow <ip>:<port> (with --reset) to restrict it."
fi

install_files() {
    local f want got names=()
    mkdir -p "$INSTALL_DIR"
    if [ -n "$EMBEDDED_FILES" ]; then
        read -r -a names <<< "$EMBEDDED_FILES"
        for f in ${names[@]+"${names[@]}"}; do
            embedded_b64 "$f" | decode_b64_to "$INSTALL_DIR/$f"
            want="$(embedded_sha256 "$f")"
            got="$(sha256_of "$INSTALL_DIR/$f")"
            [ "$want" = "$got" ] || die "$f: SHA-256 mismatch after unpacking (installer damaged?) - download it again from the app"
        done
        say "Unpacked bridge v$EMBEDDED_VERSION (SHA-256 verified)"
    else
        [ -n "$SCRIPT_DIR" ] || die "this installer has no bridge files built in - piped into bash, use the release installer: curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes"
        [ -f "$SCRIPT_DIR/modbus-bridge.js" ] || die "modbus-bridge.js was not found next to this installer ($SCRIPT_DIR). Download the bridge package from the app's Modbus page, unzip it and run install.sh from that folder."
        for f in modbus-bridge.js fake-slave.js README.md; do
            if [ -f "$SCRIPT_DIR/$f" ] && ! [ "$SCRIPT_DIR/$f" -ef "$INSTALL_DIR/$f" ]; then
                cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
            fi
        done
    fi
    if [ -n "$SELF" ] && [ -f "$SELF" ] && ! [ "$SELF" -ef "$INSTALL_DIR/install.sh" ]; then
        cp "$SELF" "$INSTALL_DIR/install.sh"
    fi
    chmod 644 "$INSTALL_DIR/modbus-bridge.js"
    if [ -f "$INSTALL_DIR/install.sh" ]; then chmod 755 "$INSTALL_DIR/install.sh"; fi
    return 0
}
write_config() {                    # JSON written by node; origins / anyOrigin / verbose of the old file kept
    local f="$INSTALL_DIR/bridge-config.json" tmp="$INSTALL_DIR/bridge-config.json.tmp"
    "$NODE_BIN" -e '
const fs=require("fs");const a=process.argv.slice(1);
const f=a[0],tmp=a[1],reset=a[2]==="1",port=+a[3],listen=a[4],writes=a[5]==="1",n=+a[6];
const allow=a.slice(7,7+n),newOrigins=a.slice(7+n);let old={};
if(!reset){try{const o=JSON.parse(fs.readFileSync(f,"utf8").replace(/^\uFEFF/,""));if(o&&typeof o==="object"&&!Array.isArray(o))old=o;}catch(e){}}
const seen=new Set(),origins=[];
(Array.isArray(old.origins)?old.origins:[]).concat(newOrigins).forEach((o)=>{if(typeof o!=="string"||!o.trim())return;const k=o.trim().toLowerCase();if(!seen.has(k)){seen.add(k);origins.push(o.trim());}});
const out={_comment:"WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to. Running the installer again keeps these settings and adds new targets (--reset starts over). Restart the bridge after editing.",
  allow:allow,port:port,listen:listen,origins:origins,anyOrigin:old.anyOrigin===true,allowWrites:writes,verbose:old.verbose===true};
fs.writeFileSync(tmp,JSON.stringify(out,null,2)+"\n");' \
        "$f" "$tmp" "$RESET" "$PORT" "$LISTEN" "$ALLOW_WRITES" "${#ALLOW_LIST[@]}" \
        ${ALLOW_LIST[@]+"${ALLOW_LIST[@]}"} ${NEW_ORIGINS[@]+"${NEW_ORIGINS[@]}"}
    if [ -f "$f" ] && ! cmp -s "$f" "$tmp"; then cp "$f" "$f.bak"; fi
    mv "$tmp" "$f"
    return 0
}
write_start_script() {
    local f="$INSTALL_DIR/start-bridge.sh" q_node q_js q_cfg
    q_node="$(printf '%q' "$NODE_BIN")"
    q_js="$(printf '%q' "$INSTALL_DIR/modbus-bridge.js")"
    q_cfg="$(printf '%q' "$INSTALL_DIR/bridge-config.json")"
    {
        printf '#!/usr/bin/env bash\n'
        printf '# Starts the WTS Modbus bridge with bridge-config.json (written by install.sh).\n'
        printf '# Extra options are passed on, e.g.  start-bridge.sh --verbose\n'
        # shellcheck disable=SC2016
        printf 'exec %s %s --config %s "$@"\n' "$q_node" "$q_js" "$q_cfg"
    } > "$f"
    chmod 755 "$f"
    return 0
}
launchagent_load() {                # (re)load the LaunchAgent - it starts the bridge now (RunAtLoad)
    local uid i
    uid="$(id -u)"
    launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
    for i in 1 2 3 4 5; do
        if launchctl bootstrap "gui/$uid" "$PLIST" >/dev/null 2>&1; then break; fi
        if [ "$i" = 5 ]; then
            launchctl unload "$PLIST" >/dev/null 2>&1 || true
            launchctl load -w "$PLIST" >/dev/null 2>&1 || return 1
        fi
        sleep 1
    done
    launchctl kickstart -k "gui/$uid/$LABEL" >/dev/null 2>&1 || true
    return 0
}
setup_launchagent() {               # $1 = 1: start it now as well
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$INSTALL_DIR/modbus-bridge.js")</string>
    <string>--config</string>
    <string>$(xml_escape "$INSTALL_DIR/bridge-config.json")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$INSTALL_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$INSTALL_DIR/bridge.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$INSTALL_DIR/bridge.log")</string>
</dict>
</plist>
EOF
    if [ "${1:-1}" = 1 ]; then
        launchagent_load || die "launchctl could not load $PLIST"
        say "LaunchAgent installed: $PLIST (starts at login; log: $INSTALL_DIR/bridge.log)"
    else
        say "LaunchAgent installed: $PLIST - the bridge starts at the next login (log: $INSTALL_DIR/bridge.log)"
    fi
    return 0
}
setup_systemd() {                   # $1 = 1: start it now as well
    mkdir -p "$(dirname "$UNIT_FILE")"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=WTS Modbus Bridge (WebSocket to Modbus TCP)
After=network.target

[Service]
Type=simple
ExecStart=$(systemd_quote "$NODE_BIN") $(systemd_quote "$INSTALL_DIR/modbus-bridge.js") --config $(systemd_quote "$INSTALL_DIR/bridge-config.json")
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 || die "systemctl --user enable $UNIT_NAME failed"
    if [ "${1:-1}" = 1 ]; then
        systemctl --user restart "$UNIT_NAME" || die "systemctl --user restart $UNIT_NAME failed (see: journalctl --user -u $UNIT_NAME)"
        say "systemd --user service installed: $UNIT_FILE (starts at login)"
    else
        say "systemd --user service installed and enabled: $UNIT_FILE - the bridge starts at the next login"
        say "  (or now with: systemctl --user start $UNIT_NAME)"
    fi
    say "  status: systemctl --user status $UNIT_NAME    log: journalctl --user -u $UNIT_NAME"
    say "  to keep it running while you are logged out: loginctl enable-linger \"\$USER\""
    return 0
}
restart_existing_autostart() {      # succeeds when the auto-start bridge was restarted
    if [ "$OS" = macos ]; then
        launchagent_load
    else
        systemd_user_ok && systemctl --user restart "$UNIT_NAME"
    fi
}
next_steps() {
    say ""
    say "Next steps in the Well Testing Suite (Modbus Config page):"
    say "  1. For each device choose transport \"Modbus TCP via WebSocket bridge\", enter the"
    say "     PLC's IP address and port, and the bridge URL ws://$HEALTH_HOST:$PORT"
    say "  2. Press \"Check bridge\" in the setup guide, then \"Test\" on the device row."
    say ""
    say "Installed in:  $INSTALL_DIR"
    say "Settings:      $INSTALL_DIR/bridge-config.json (restart the bridge after editing)"
    say "Add a device:  bash \"$INSTALL_DIR/install.sh\" --allow <ip>:<port>   (keeps the other settings)"
    say "Start by hand: \"$INSTALL_DIR/start-bridge.sh\""
    say "Uninstall:     bash \"$INSTALL_DIR/install.sh\" --uninstall"
}
report_running() {
    say ""
    say "OK: the WTS Modbus bridge is running - $(printf '%s' "$HEALTH_JSON" | describe_health)"
    say "    health check: http://$HEALTH_HOST:$PORT/health"
}
check_running() {                   # after wait_health: the answer must come from the bridge just configured
    if ! verify_health; then
        if [ -n "${BRIDGE_PID:-}" ]; then kill "$BRIDGE_PID" 2>/dev/null || true; fi
        die "the bridge answering on port $PORT is not the one just installed ($(printf '%s' "$HEALTH_JSON" | describe_health)). Another bridge may be running: stop it and run the installer again."
    fi
    report_running
}

HEALTH_JSON=""
# Before anything is written: stop the bridges of an earlier install, then the port must be free
# (otherwise the new bridge could not start, and the settings on disk would not match the bridge
# that answers).
if [ "$NO_START" != 1 ]; then
    stop_our_bridges
    if port_in_use; then
        if HEALTH_JSON="$(fetch_health)"; then
            die "another WTS Modbus bridge already answers on http://$HEALTH_HOST:$PORT ($(printf '%s' "$HEALTH_JSON" | describe_health)) - it was not started by this install (a bridge started by hand?). Stop it first (Ctrl+C in its window), or install with --port <other>. Nothing was changed."
        fi
        die "another program already uses port $PORT on $HEALTH_HOST. Stop it, or install with --port <other> (and use that port in the device bridge URL). Nothing was changed."
    fi
fi
install_files
write_config
write_start_script
MODE="read-only"
if [ "$ALLOW_WRITES" = 1 ]; then MODE="writes ALLOWED"; fi
say "Installed the WTS Modbus bridge in $INSTALL_DIR"
say "  allowed targets: ${ALLOW_LIST[*]:-(none)}   port: $PORT   $MODE"

if [ "$AUTOSTART" = 1 ]; then
    START_NOW=1
    if [ "$NO_START" = 1 ]; then START_NOW=0; fi
    if [ "$OS" = macos ]; then
        setup_launchagent "$START_NOW"
    elif systemd_user_ok; then
        setup_systemd "$START_NOW"
    else
        warn "systemd --user is not available here (no user session bus - e.g. WSL, a container or an SSH-only login), so auto-start was not set up."
        say "  Start the bridge yourself with \"$INSTALL_DIR/start-bridge.sh\", or add that command to your"
        say "  desktop's Startup Applications (or 'crontab -e' with: @reboot \"$INSTALL_DIR/start-bridge.sh\")."
        if [ "$NO_START" != 1 ]; then say "  Starting it in this window now."; fi
        AUTOSTART=0
    fi
elif [ "$NO_START" != 1 ] && autostart_installed; then
    if restart_existing_autostart; then
        say "Restarted the auto-start bridge from an earlier install with the new settings."
        AUTOSTART=1
    else
        warn "could not restart the auto-start bridge from an earlier install - starting one in this window."
    fi
fi

if [ "$NO_START" = 1 ]; then next_steps; exit 0; fi

if [ "$AUTOSTART" = 1 ]; then
    if wait_health 15; then check_running
    else warn "the bridge did not answer on http://$HEALTH_HOST:$PORT/health within 15 s - check the log (see above)."; fi
    next_steps
    exit 0
fi

# Foreground: run the bridge from this terminal, check it, then wait until Ctrl+C.
"$INSTALL_DIR/start-bridge.sh" &
BRIDGE_PID=$!
stop_bridge() {
    trap - INT TERM HUP
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
    say ""
    say "Bridge stopped."
    exit 0
}
trap stop_bridge INT TERM HUP
if wait_health 15 "$BRIDGE_PID"; then
    check_running
    next_steps
    say ""
    say "The bridge runs in this window - leave it open while you use the app; Ctrl+C stops it."
    say "(Install with --autostart to start it automatically at login instead.)"
else
    if kill -0 "$BRIDGE_PID" 2>/dev/null; then
        warn "the bridge did not answer on http://$HEALTH_HOST:$PORT/health within 15 s."
    else
        wait "$BRIDGE_PID" 2>/dev/null || true
        die "the bridge stopped (see the message above)."
    fi
fi
set +e
wait "$BRIDGE_PID"
code=$?
set -e
trap - INT TERM HUP
say ""
say "The bridge stopped (exit code $code) - it was stopped from outside this window, or a new install replaced it."
exit "$code"
}
