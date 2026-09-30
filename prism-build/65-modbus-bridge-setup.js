// =============================================================================
// 65-modbus-bridge-setup.js — WebSocket-bridge setup helpers for the Modbus page guide
// -----------------------------------------------------------------------------
// window.WTS_modbusBridgeSetup (pure functions + one fetch; no timers except the one-shot
// timeout of checkBridge, cleared when it settles):
//   validateTarget(s)        → {ok, value, error}  host:port, host = IPv4 | IPv4/nn | host name
//                              ([A-Za-z0-9._-]) | [IPv6], port 1-65535 or * — the same rules as
//                              the installers, so nothing reaches a script that a shell could run
//   validateListen(s)        → bool (IPv4 or localhost; installers get localhost as 127.0.0.1)
//   validateOrigin(s)        → bool (null | file:// | http(s)://host[:port])
//   bridgeAcceptsOrigin(o)   → bool: one of the bridge's built-in page origins (mirror of DEFAULT_ORIGINS)
//   pageOrigin()             → this page's origin ('null' for a saved file:// copy)
//   parseBridgeUrl(url)      → {ok, host, port, secure, loopback, healthUrl, error}
//   targetsFromConfig(cfg, extra) → {targets:[{name, host, port, target, url}], errors, urls, port, listen, warnings}
//   buildInstaller(os, {allow, port, listen, allowWrites, autostart, origins}) → {ok, filename, text, errors, warnings, commands}
//   installerFromConfig(cfg, os, {extra, allowWrites, autostart, origins}) → same, targets from the
//                              "Modbus TCP via WebSocket bridge" devices (+ extra host:port list);
//                              origins default to this page's origin when the bridge would refuse it
//                              (a custom http(s) site — never "null")
//   commandsFor(os, o)       → {node, installer, packaged, direct, uninstall} (values with * or [ ]
//                              single-quoted for sh / zsh, double-quoted for PowerShell / cmd; *:* in
//                              allow = --allow-any / -AllowAny, which replaces an older installer's list)
//   quickSetup(os, {port})   → {os, exeUrl, shUrl, oneLiner, releasesUrl}: the one-click paths from the GitHub
//                              release (Windows: WTS-Modbus-Bridge-Setup.exe; macOS / Linux: curl … | bash)
//   releaseInstaller()       → {ok, filename, text, version, files}: the self-contained install.sh of the GitHub
//                              release (presets empty = any device, read-only, port 8502; bridge files AND
//                              install.sh embedded, so it works piped into bash and can --uninstall later)
//   zip(entries, date)       → Uint8Array (stored ZIP, CRC-32; Unix modes for install.sh)
//   packageZip(date)         → {filename, bytes, files}
//   allowedBy(specs, host, port) → bool (the bridge's allow-list rules)
//   checkBridge(cfg, {fetch, timeoutMs, url}) → Promise<{ok, results:[…]}>  (GET <bridge>/health; a
//                              refusal is 403 {"error":"origin"|"host"}; when the CORS request fails a
//                              no-cors probe tells "something answered" from "nothing listens")
// The bridge files come from window.WTS_modbusBridgePack (64-modbus-bridge-pack.js).
// =============================================================================
(function () {
'use strict';
var G = (typeof window !== 'undefined') ? window : globalThis;

var DEFAULT_URL = 'ws://127.0.0.1:8502';
var BRIDGE_NAME = 'wts-modbus-bridge';
var SH_FILES = ['modbus-bridge.js', 'fake-slave.js', 'README.md'];
// One-click downloads: GitHub release assets built by .github/workflows/modbus-bridge-release.yml
// (tag modbus-bridge-v<version>). The repository is public, so they download without a login.
var RELEASE_REPO = 'https://github.com/h2oil/well-testing-suite';
var RELEASE_LATEST = RELEASE_REPO + '/releases/latest/download/';
var EXE_FILE = 'WTS-Modbus-Bridge-Setup.exe';
var SH_RELEASE_FILE = 'wts-modbus-bridge-install.sh';

function pack() { var P = G.WTS_modbusBridgePack; return (P && P.files && P.files['modbus-bridge.js']) ? P : null; }

// ─── validation ──────────────────────────────────────────────────────────────
function isIPv4(s) {
    var m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(String(s));
    if (!m) return false;
    for (var i = 1; i <= 4; i++) if (+m[i] > 255) return false;
    return true;
}
// IPv6 (no zone id): hex digits, colons and dots, at least two colons — shell-safe characters
function isIPv6(a) { a = String(a == null ? '' : a); return /^[0-9A-Fa-f:.]{2,45}$/.test(a) && a.split(':').length >= 3; }
function validHost(h) {
    h = String(h == null ? '' : h);
    if (h.length < 1 || h.length > 253) return false;
    if (h[0] === '[' && h[h.length - 1] === ']') return isIPv6(h.slice(1, -1));
    if (h.indexOf('/') >= 0) { var p = h.split('/'); return p.length === 2 && isIPv4(p[0]) && /^[0-9]{1,2}$/.test(p[1]) && +p[1] <= 32; }
    if (/^[0-9.]+$/.test(h)) return isIPv4(h);
    return /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/.test(h) && h.indexOf('..') < 0;
}
function validPort(p) { p = String(p == null ? '' : p); return /^[0-9]{1,5}$/.test(p) && +p >= 1 && +p <= 65535; }
function validateTarget(s) {
    var t = String(s == null ? '' : s).trim(), i = t.lastIndexOf(':');
    if (i <= 0) return { ok: false, value: t, error: '"' + t + '" is not host:port' };
    var h = t.slice(0, i), p = t.slice(i + 1);
    if (h === '*') {   // any device (bridge ≥ 1.2.0)
        if (p !== '*' && !validPort(p)) return { ok: false, value: t, error: 'port "' + p + '" must be 1-65535 or *' };
        return { ok: true, value: '*:' + (p === '*' ? '*' : String(+p)), host: '*', port: p === '*' ? '*' : +p };
    }
    if (!validHost(h)) {
        if (isIPv6(h)) return { ok: false, value: t, error: 'put the IPv6 address "' + h + '" in brackets: [' + h + ']:' + p };
        return { ok: false, value: t, error: '"' + h + '" is not an IPv4 address, IPv4 subnet (a.b.c.d/nn), host name or [IPv6] address' };
    }
    if (p !== '*' && !validPort(p)) return { ok: false, value: t, error: 'port "' + p + '" of ' + h + ' must be 1-65535 or *' };
    return { ok: true, value: h.toLowerCase() + ':' + (p === '*' ? '*' : String(+p)), host: h.toLowerCase(), port: p === '*' ? '*' : +p };
}
function validateListen(s) { return s === 'localhost' || isIPv4(s); }
// "localhost" can resolve to ::1 only (macOS, Windows) while the app uses 127.0.0.1
function normListen(s) { return s === 'localhost' ? '127.0.0.1' : s; }
function validateOrigin(o) {
    o = String(o == null ? '' : o);
    if (o === 'null' || o === 'file://') return true;
    var m = /^https?:\/\/([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?$/.exec(o);
    return !!m && o.length <= 300 && (m[2] == null || validPort(m[2]));
}
// Mirror of modbus-bridge.js DEFAULT_ORIGINS: the page origins a bridge accepts without --origin.
function bridgeAcceptsOrigin(o) {
    o = String(o == null ? '' : o);
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o) || /^https:\/\/(www\.)?pb-handbook\.com$/i.test(o) || /^capacitor:\/\/localhost$/i.test(o);
}
function pageOrigin() {
    try {
        var L = G.location;
        if (!L) return '';
        if (L.protocol === 'file:') return 'null';          // browsers send "Origin: null" for file:// pages
        return String(L.origin || '');
    } catch (e) { return ''; }
}
function splitList(s) { return String(s == null ? '' : s).split(/[\s,]+/).filter(Boolean); }

function parseBridgeUrl(u) {
    var s = String(u == null ? '' : u).trim() || DEFAULT_URL;
    var m = /^(wss?|https?):\/\/(\[[0-9A-Fa-f:.]+\]|[^\/:?#\s@]+)(?::([0-9]{1,5}))?(?:[\/?#][^\s]*)?$/i.exec(s);
    if (!m) return { ok: false, url: s, error: 'bridge URL "' + s + '" is not of the form ws://host:port' };
    var scheme = m[1].toLowerCase(), secure = scheme === 'wss' || scheme === 'https', host = m[2].toLowerCase();
    var port = m[3] ? +m[3] : (secure ? 443 : 80);
    if (!(port >= 1 && port <= 65535)) return { ok: false, url: s, error: 'bridge URL "' + s + '": port must be 1-65535' };
    if (host[0] !== '[' && !validHost(host)) return { ok: false, url: s, error: 'bridge URL "' + s + '": bad host name' };
    var loopback = /^(127\.[0-9]+\.[0-9]+\.[0-9]+|localhost|\[::1\])$/.test(host);
    return { ok: true, url: s, host: host, port: port, secure: secure, loopback: loopback,
        healthUrl: (secure ? 'https' : 'http') + '://' + host + ':' + port + '/health' };
}

// ─── targets from the Modbus configuration ───────────────────────────────────
function targetsFromConfig(cfg, extra) {
    var out = { targets: [], errors: [], urls: [], warnings: [], port: 8502, listen: '' }, seen = {}, seenUrl = {};
    ((cfg && cfg.devices) || []).forEach(function (d) {
        if (!d || d.transport !== 'ws') return;
        var name = String(d.name || d.id || 'device'), host = String(d.host == null ? '' : d.host).trim();
        if (host.indexOf(':') >= 0 && host[0] !== '[') host = '[' + host + ']';       // IPv6 device address
        var v = validateTarget(host + ':' + (d.port == null || d.port === '' ? 502 : d.port));
        var u = parseBridgeUrl(d.url);
        if (!u.ok) out.errors.push('Device "' + name + '": ' + u.error);
        else if (!seenUrl[u.healthUrl]) { seenUrl[u.healthUrl] = 1; out.urls.push(u); }
        if (!v.ok) { out.errors.push('Device "' + name + '": ' + v.error); return; }
        out.targets.push({ name: name, host: v.host, port: v.port, target: v.value, url: u.ok ? u.healthUrl : null });
        seen[v.value] = 1;
    });
    splitList(extra).forEach(function (x) {
        var v = validateTarget(x);
        if (!v.ok) { out.errors.push('Extra target: ' + v.error); return; }
        if (!seen[v.value]) { seen[v.value] = 1; out.targets.push({ name: '(extra)', host: v.host, port: v.port, target: v.value, url: null, extra: true }); }
    });
    if (out.urls.length) {
        var u0 = out.urls[0];
        out.port = u0.port;
        if (out.urls.length > 1) out.warnings.push('Your devices use ' + out.urls.length + ' different bridge URLs; the installer is for ' + u0.url + ' (port ' + u0.port + ').');
        if (!u0.loopback) {
            if (isIPv4(u0.host)) {
                out.listen = u0.host;
                out.warnings.push('The bridge URL points at ' + u0.host + ', not this computer: run the installer on that PC. The bridge will then listen on ' + u0.host + ', so other machines on that network can use it.');
            } else out.warnings.push('The bridge URL points at ' + u0.host + ', not this computer: put that PC\'s IP address in the device bridge URL (ws://<its IP>:' + u0.port + ') and generate the installer again — it then listens on that address. (With the host name, run the installer on that PC with --listen <its IP address>.)');
        }
        if (u0.secure) out.warnings.push('The bridge speaks plain ws:// — use ws:// (not wss://) in the bridge URL.');
    }
    return out;
}

// ─── installers ──────────────────────────────────────────────────────────────
function replaceBlock(text, tag, lines) {
    var b = '# @@WTS-' + tag + '-BEGIN@@', e = '# @@WTS-' + tag + '-END@@';
    var i = text.indexOf(b), j = text.indexOf(e);
    if (i < 0 || j < i) return null;
    var lineEnd = text.indexOf('\n', j); if (lineEnd < 0) lineEnd = text.length;
    return text.slice(0, i) + lines.join('\n') + text.slice(lineEnd);
}
function utf8(s) {
    s = String(s);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
}
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
    var out = '', i, n = bytes.length;
    for (i = 0; i + 2 < n; i += 3) {
        var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    }
    if (n - i === 1) { var a = bytes[i] << 16; out += B64[(a >> 18) & 63] + B64[(a >> 12) & 63] + '=='; }
    else if (n - i === 2) { var c = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[(c >> 18) & 63] + B64[(c >> 12) & 63] + B64[(c >> 6) & 63] + '='; }
    return out;
}
function chunks(s, n) { var out = []; for (var i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }

function shInstaller(P, o) {
    var tpl = P.files['install.sh'], files = o.files || SH_FILES;
    var preset = o.keepPreset ? null : [
        '# @@WTS-PRESET-BEGIN@@ (generated by the Well Testing Suite for your devices; bridge v' + P.version + ')',
        'PRESET_ALLOW="' + o.allow.join(',') + '"',
        'PRESET_PORT="' + o.port + '"',
        'PRESET_LISTEN="' + (o.listen || '127.0.0.1') + '"',
        'PRESET_ALLOW_WRITES="' + (o.allowWrites ? 1 : 0) + '"',
        'PRESET_AUTOSTART="' + (o.autostart ? 1 : 0) + '"',
        'PRESET_ORIGINS="' + (o.origins || []).join(',') + '"',
        '# @@WTS-PRESET-END@@'];
    var sums = [], bodies = [];
    files.forEach(function (f) {
        if (typeof P.files[f] !== 'string') return;
        sums.push('        ' + f + ") printf '%s' '" + P.sha256[f] + "' ;;");
        bodies.push('        ' + f + ')', "            cat <<'WTS_PAYLOAD_EOF'");
        Array.prototype.push.apply(bodies, chunks(base64(utf8(P.files[f])), 76));
        bodies.push('WTS_PAYLOAD_EOF', '            ;;');
    });
    var payload = ['# @@WTS-PAYLOAD-BEGIN@@ (bridge v' + P.version + ' embedded by the Well Testing Suite; SHA-256 checked when unpacked)',
        'EMBEDDED_FILES="' + files.filter(function (f) { return typeof P.files[f] === 'string'; }).join(' ') + '"',
        'EMBEDDED_VERSION="' + P.version + '"',
        'embedded_sha256() {', '    case "$1" in'].concat(sums, ['        *) return 1 ;;', '    esac', '}',
        'embedded_b64() {', '    case "$1" in'], bodies, ['        *) return 1 ;;', '    esac', '}', '# @@WTS-PAYLOAD-END@@']);
    var t = o.keepPreset ? tpl : replaceBlock(tpl, 'PRESET', preset);
    t = t && replaceBlock(t, 'PAYLOAD', payload);
    return t;
}
// The GitHub release's install.sh: the template's empty presets (any device IP / port, read-only,
// port 8502, flags decide auto-start) + the bridge files and install.sh itself, because piped into
// bash (curl … | bash) the script has no file to keep for --uninstall and later runs.
function releaseInstaller() {
    var P = pack();
    if (!P) return { ok: false, errors: ['The bridge package is not bundled in this build.'] };
    var files = SH_FILES.concat('install.sh');
    var text = shInstaller(P, { keepPreset: true, files: files });
    if (!text) return { ok: false, errors: ['The bundled installer template has no payload block.'] };
    return { ok: true, filename: SH_RELEASE_FILE, text: text, version: P.version, files: files, errors: [] };
}
// The one-click set-up paths (GitHub release). port: the bridge port the devices use (8502 default).
function quickSetup(os, o) {
    os = normOs(os); o = o || {};
    var port = validPort(o.port) ? +o.port : 8502;
    return { os: os, exeUrl: RELEASE_LATEST + EXE_FILE, shUrl: RELEASE_LATEST + SH_RELEASE_FILE, releasesUrl: RELEASE_REPO + '/releases',
        oneLiner: 'curl -fsSL ' + RELEASE_LATEST + SH_RELEASE_FILE + ' | bash -s -- --autostart --yes' + (port !== 8502 ? ' --port ' + port : ''),
        exeFile: EXE_FILE, port: port };
}
function psInstaller(P, o) {
    var tpl = P.files['install-windows.ps1'];
    var preset = [
        '# @@WTS-PRESET-BEGIN@@ (generated by the Well Testing Suite for your devices; bridge v' + P.version + ')',
        "$PresetAllow = '" + o.allow.join(',') + "'",
        '$PresetPort = ' + o.port,
        "$PresetListen = '" + (o.listen || '127.0.0.1') + "'",
        '$PresetAllowWrites = ' + (o.allowWrites ? '$true' : '$false'),
        '$PresetAutoStart = ' + (o.autostart ? '$true' : '$false'),
        "$PresetOrigins = '" + (o.origins || []).join(',') + "'",
        '# @@WTS-PRESET-END@@'];
    var payload = ['# @@WTS-PAYLOAD-BEGIN@@ (bridge v' + P.version + ' embedded by the Well Testing Suite; SHA-256 checked when unpacked)',
        "$EmbeddedVersion = '" + P.version + "'", '$Embedded = @{}'];
    SH_FILES.forEach(function (f) {
        if (typeof P.files[f] !== 'string') return;
        var lines = chunks(base64(utf8(P.files[f])), 76).map(function (c) { return "'" + c + "'"; });
        payload.push("$Embedded['" + f + "'] = @{ Sha256 = '" + P.sha256[f] + "'; B64 = (@(");
        payload.push(lines.join(',\n'));
        payload.push(") -join '') }");
    });
    payload.push('# @@WTS-PAYLOAD-END@@');
    var t = replaceBlock(tpl, 'PRESET', preset);
    t = t && replaceBlock(t, 'PAYLOAD', payload);
    return t && t.replace(/\r?\n/g, '\r\n');          // Windows line endings for Notepad users
}

function normOs(os) { os = String(os || '').toLowerCase(); return os === 'mac' || os === 'macos' || os === 'darwin' ? 'macos' : os === 'linux' ? 'linux' : 'windows'; }
// Shell quoting for the copyable commands. Validated values only contain [A-Za-z0-9._:/*,[\]-],
// so quotes never appear inside them; * and [ ] are globs in sh / zsh (zsh aborts on an
// unmatched glob), PowerShell reads a leading [ as a type literal.
function shArg(s) { s = String(s); return /[*?\[\]]/.test(s) ? "'" + s + "'" : s; }
function winArg(s) { s = String(s); return /[*?\[\]]/.test(s) ? '"' + s + '"' : s; }
function commandsFor(os, o) {
    os = normOs(os); o = o || {};
    var allow = (o.allow || []).filter(function (a) { return validateTarget(a).ok; });
    var origins = (o.origins || []).filter(validateOrigin);
    var port = validPort(o.port) ? +o.port : 8502, listen = o.listen && validateListen(o.listen) ? normListen(o.listen) : '';
    if (listen === '127.0.0.1') listen = '';                                    // the default
    var q = os === 'windows' ? winArg : shArg;
    // any device (*:*): --allow-any / -AllowAny, which also replaces the allow list of an existing
    // bridge-config.json (an older installer's list would otherwise be kept and added to)
    var any = allow.some(function (a) { return validateTarget(a).value === '*:*'; });
    if (any) allow = [];
    var direct = 'node modbus-bridge.js' + (any ? ' --allow-any' : '') + allow.map(function (a) { return ' --allow ' + q(a); }).join('') + (port !== 8502 ? ' --port ' + port : '') +
        (listen ? ' --listen ' + listen : '') + origins.map(function (x) { return ' --origin ' + x; }).join('') + (o.allowWrites ? ' --allow-writes' : '');
    if (os === 'windows') {
        return {
            node: 'winget install OpenJS.NodeJS.LTS',
            installer: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\wts-modbus-bridge-install.ps1"',
            packaged: 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-windows.ps1' + (any ? ' -AllowAny' : ' -Allow "' + allow.join(',') + '"') + (port !== 8502 ? ' -Port ' + port : '') +
                (listen ? ' -Listen ' + listen : '') + (origins.length ? ' -Origin "' + origins.join(',') + '"' : '') + (o.allowWrites ? ' -AllowWrites' : '') + (o.autostart ? ' -AutoStart' : ''),
            direct: direct,
            uninstall: 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\\WTS Modbus Bridge\\install-windows.ps1" -Uninstall'
        };
    }
    return {
        node: os === 'macos' ? 'brew install node' : 'sudo apt-get install nodejs      # or: sudo dnf install nodejs',
        installer: 'bash ~/Downloads/wts-modbus-bridge-install.sh',
        packaged: 'bash install.sh ' + (any ? '--allow-any' : '--allow ' + (allow.length ? shArg(allow.join(',')) : '<ip>:502')) + (port !== 8502 ? ' --port ' + port : '') + (listen ? ' --listen ' + listen : '') +
            origins.map(function (x) { return ' --origin ' + x; }).join('') + (o.allowWrites ? ' --allow-writes' : '') + (o.autostart ? ' --autostart' : ''),
        direct: direct,
        uninstall: os === 'macos' ? 'bash "$HOME/Library/Application Support/WTS Modbus Bridge/install.sh" --uninstall'
            : 'bash "${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh" --uninstall'
    };
}
function buildInstaller(os, o) {
    os = normOs(os); o = o || {};
    var P = pack(), errors = [], warnings = [], allow = [];
    if (!P) return { ok: false, errors: ['The bridge package is not bundled in this build.'], warnings: warnings };
    (o.allow || []).forEach(function (a) {
        var v = validateTarget(a);
        if (!v.ok) errors.push(v.error); else if (allow.indexOf(v.value) < 0) allow.push(v.value);
    });
    var port = (o.port == null || o.port === '') ? 8502 : o.port;
    if (!validPort(port)) errors.push('bridge port "' + port + '" must be 1-65535'); else port = +port;
    var listen = o.listen ? String(o.listen) : '';
    if (listen && !validateListen(listen)) errors.push('listen address "' + listen + '" must be an IPv4 address or localhost');
    else listen = normListen(listen);
    var origins = [];
    (o.origins || []).forEach(function (x) {
        x = String(x == null ? '' : x).trim();
        if (!x) return;
        if (!validateOrigin(x)) errors.push('page origin "' + x + '" must be https://host[:port], http://host[:port], null or file://');
        else if (origins.indexOf(x) < 0) origins.push(x);
    });
    if (!allow.length && !errors.length) errors.push('No targets yet: add a device with transport "Modbus TCP via WebSocket bridge" (its host / IP and port), or enter a target.');
    if (errors.length) return { ok: false, errors: errors, warnings: warnings };
    var opts = { allow: allow, port: port, listen: listen, allowWrites: !!o.allowWrites, autostart: !!o.autostart, origins: origins };
    var text = os === 'windows' ? psInstaller(P, opts) : shInstaller(P, opts);
    if (!text) return { ok: false, errors: ['The bundled installer template has no preset / payload block.'], warnings: warnings };
    return { ok: true, os: os, filename: os === 'windows' ? 'wts-modbus-bridge-install.ps1' : 'wts-modbus-bridge-install.sh',
        type: os === 'windows' ? 'text/plain' : 'application/x-sh', text: text, allow: allow, port: port, listen: listen, origins: origins,
        version: P.version, errors: [], warnings: warnings, commands: commandsFor(os, opts) };
}
// The page's own origin when the bridge would refuse it (the app served from a custom site), so
// the generated installer accepts it. Never "null": any web site can send that (saved copies
// opt in with --origin null, see originNote()).
function autoOrigins() { var o = pageOrigin(); return /^https?:\/\//i.test(o) && validateOrigin(o) && !bridgeAcceptsOrigin(o) ? [o] : []; }
function originNote() {
    var o = pageOrigin();
    if (o === 'null') return 'This page is a saved copy (file://), so the browser sends "Origin: null" — which the bridge refuses by default, because any web site can send it too. Open the app from https://pb-handbook.com or http://localhost instead, or add --origin null (-Origin null on Windows) to the installer command — only on a PC that is not used for general web browsing.';
    if (autoOrigins().length) return 'This page is served from ' + o + ', which the bridge does not accept by default: the generated installer adds it (--origin ' + o + ').';
    return '';
}
function installerFromConfig(cfg, os, o) {
    o = o || {};
    var t = targetsFromConfig(cfg, o.extra);
    if (o.anyIp) t.errors = [];     // any device IP / port (*:*): the per-device targets are not needed
    if (t.errors.length) return { ok: false, errors: t.errors, warnings: t.warnings, targets: t.targets };
    var r = buildInstaller(os, { allow: o.anyIp ? ['*:*'] : t.targets.map(function (x) { return x.target; }), port: t.port, listen: t.listen, allowWrites: o.allowWrites, autostart: o.autostart,
        origins: o.origins != null ? o.origins : autoOrigins() });
    r.warnings = t.warnings.concat(r.warnings || []);
    r.targets = t.targets;
    return r;
}

// ─── ZIP (stored) ────────────────────────────────────────────────────────────
var CRC = null;
function crc32(bytes) {
    if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0; } }
    var x = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) x = CRC[(x ^ bytes[i]) & 0xFF] ^ (x >>> 8);
    return (x ^ 0xFFFFFFFF) >>> 0;
}
// entries: [{name, data: string | byte array, mode: 0o755 | 0o644}] → Uint8Array
function zip(entries, date) {
    var d = date || new Date(), yr = Math.max(1980, d.getFullYear());
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((yr - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var files = entries.map(function (e) {
        var data = typeof e.data === 'string' ? utf8(e.data) : e.data, name = utf8(e.name);
        return { name: name, data: data, crc: crc32(data), mode: e.mode || 420 };
    });
    var size = 22;
    files.forEach(function (f) { size += 30 + f.name.length + f.data.length + 46 + f.name.length; });
    var buf = new Uint8Array(size), dv = new DataView(buf.buffer), p = 0, cd = [];
    function u16(v) { dv.setUint16(p, v, true); p += 2; }
    function u32(v) { dv.setUint32(p, v >>> 0, true); p += 4; }
    function bytes(b) { buf.set(b, p); p += b.length; }
    files.forEach(function (f) {
        f.offset = p;
        u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
        u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.name.length); u16(0);
        bytes(f.name); bytes(f.data);
    });
    var cdStart = p;
    files.forEach(function (f) {
        u32(0x02014b50); u16((3 << 8) | 20); u16(20); u16(0x0800); u16(0); u16(dosTime); u16(dosDate);
        u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.name.length); u16(0); u16(0); u16(0); u16(0);
        u32((0x8000 | f.mode) * 65536); u32(f.offset);
        bytes(f.name);
        cd.push(f);
    });
    var cdSize = p - cdStart;
    u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length); u32(cdSize); u32(cdStart); u16(0);
    return buf;
}
function packageZip(date) {
    var P = pack();
    if (!P) return null;
    var dir = 'wts-modbus-bridge/';
    var entries = P.order.filter(function (f) { return typeof P.files[f] === 'string'; }).map(function (f) {
        return { name: dir + f, data: P.files[f], mode: /\.sh$/.test(f) ? 493 : 420 };
    });
    return { filename: 'wts-modbus-bridge-' + P.version + '.zip', bytes: zip(entries, date), files: entries.map(function (e) { return e.name; }), version: P.version };
}

// ─── allow-list rules (mirror of modbus-bridge.js parseAllow / allowed) ─────
function ip4num(s) { if (!isIPv4(s)) return null; var p = s.split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; }
function allowedBy(specs, host, port) {
    host = String(host || '').toLowerCase().replace(/^\[|\]$/g, ''); port = +port;
    return (specs || []).some(function (spec) {
        var s = String(spec).trim(), i = s.lastIndexOf(':');
        if (i <= 0) return false;
        var h = s.slice(0, i).replace(/^\[|\]$/g, '').toLowerCase(), p = s.slice(i + 1);
        if (p !== '*' && +p !== port) return false;
        if (h === '*') return true;
        var m = /^([0-9.]+)\/([0-9]+)$/.exec(h);
        if (m) {
            var ip = ip4num(host), base = ip4num(m[1]), bits = +m[2];
            if (ip == null || base == null || !(bits >= 0 && bits <= 32)) return false;
            var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
            return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
        }
        return h === host;
    });
}
function versionLess(a, b) {
    var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) { var p = x[i] || 0, q = y[i] || 0; if (p !== q) return p < q; }
    return false;
}

// ─── Check bridge (GET /health) ──────────────────────────────────────────────
// How to switch a restricted bridge to any device (plain text; the config paths are the installers').
var ALLOW_FIX = [
    'Fix: run the installer again — ' + EXE_FILE + ' on Windows, or the one-line command on macOS / Linux (step 1 above). From bridge v1.2.1 on it switches the bridge to any device.',
    'Windows, without reinstalling: press Win+R, run  "%LOCALAPPDATA%\\WTS Modbus Bridge\\WTS-Modbus-Bridge.exe" --allow-any  — it rewrites the settings and restarts the bridge (setup-exe install).',
    'Or by hand: in bridge-config.json set "allow": [] (an empty list = any device), save, then restart the bridge. The file is in %LOCALAPPDATA%\\WTS Modbus Bridge\\ (Windows, setup exe or install-windows.ps1), ~/Library/Application Support/WTS Modbus Bridge/ (macOS) or ~/.local/share/wts-modbus-bridge/ (Linux).',
    'Restart it: Windows (setup exe) — end WTS-Modbus-Bridge.exe in Task Manager, then Start menu → "WTS Modbus Bridge — status"; Windows (install-windows.ps1) — close the "WTS Modbus Bridge" window, then Start menu → "WTS Modbus Bridge"; macOS / Linux — Ctrl+C in its Terminal and run start-bridge.sh from that folder (auto-start: systemctl --user restart wts-modbus-bridge, or log out and in on macOS).'
];
function originText() { return pageOrigin(); }
function originHint() {
    var o = originText() || '<origin>';
    if (o === 'null') return 'This page is a saved copy (file://): browsers send "Origin: null", which the bridge refuses by default because any web site can send it. Open the app from https://pb-handbook.com or http://localhost, or — only on a PC not used for general browsing — add "null" to "origins" in bridge-config.json (installer: --origin null / -Origin null) and restart the bridge.';
    return 'Add this page\'s origin (' + o + ') to "origins" in bridge-config.json — or run the installer again with --origin ' + o + ' (Windows: -Origin ' + o + ') — and restart the bridge.';
}
function failHints(u, kind) {
    var h = [], o = originText();
    if (kind === 'origin') { h.push('The bridge refused this page\'s origin (' + (o || 'unknown') + ').'); h.push(originHint()); return h; }
    if (kind === 'host') {
        h.push('The bridge answers under a host name (' + u.host + ') only for pages from an accepted web origin; this page (' + (o || 'unknown') + ') is not one, so the name is refused (protection against DNS rebinding).');
        h.push('Put the bridge PC\'s IP address in the device bridge URL (ws://<IP>:' + u.port + ')' + (o === 'null' ? ', or open the app from https://pb-handbook.com or http://localhost.' : '.'));
        return h;
    }
    if (kind === 'forbidden') {           // an older v1.1.0 bridge: plain 403, reason unknown
        h.push('Either this page\'s origin (' + (o || 'unknown') + ') is not accepted: ' + originHint());
        h.push('Or the bridge URL uses a host name: put the bridge PC\'s IP address in the device bridge URL instead.');
        return h;
    }
    if (kind === 'opaque') {
        h.push('Something is listening at ' + u.healthUrl.replace(/\/health$/, '') + ', but the browser was not allowed to read its reply.');
        if (o && !bridgeAcceptsOrigin(o)) h.push('The bridge probably refused this page\'s origin (' + o + '). ' + originHint());
        h.push('A bridge older than v1.1 has no health check — download the package again and re-run the installer.');
        h.push('Chrome / Edge may ask to allow this site to access apps or devices on your local network — choose Allow.');
        return h;
    }
    h.push('Is the bridge running? Windows: Start menu → "WTS Modbus Bridge — status" (starts it and opens its status page; after a script install: "WTS Modbus Bridge"), or run WTS-Modbus-Bridge-Setup.exe again. macOS / Linux: run the one-line installer again, or start-bridge.sh from the install folder.');
    if (o && !bridgeAcceptsOrigin(o)) h.push('The bridge accepts only pages from localhost, 127.0.0.1 and pb-handbook.com by default, and a browser cannot read its refusal from every site: ' + originHint());
    h.push('Is the port right? The bridge URL of your devices must match the bridge (' + u.url + ').');
    h.push('A bridge older than v1.1 has no health check — download the package again and re-run the installer.');
    if (!u.loopback) h.push('The bridge is on another computer: it must listen on that PC\'s network address (listen in bridge-config.json) and the firewall must allow TCP ' + u.port + '.');
    h.push('Chrome / Edge may ask to allow this site to access apps or devices on your local network — choose Allow. Other browsers may block an https page from reaching http://127.0.0.1: use Chrome / Edge, or open the app from http://localhost or a saved copy.');
    return h;
}
function checkOne(u, devices, f, opts) {
    var base = { url: u.url, healthUrl: u.healthUrl, devices: [], hints: [] };
    if (!u.ok) return Promise.resolve(Object.assign(base, { ok: false, error: u.error }));
    if (typeof f !== 'function') return Promise.resolve(Object.assign(base, { ok: false, error: 'This browser cannot run the check (no fetch).' }));
    var ms = opts.timeoutMs || 4000, timer = null, timedOut = false, ctl = null;
    try { if (typeof AbortController !== 'undefined') ctl = new AbortController(); } catch (e) { ctl = null; }
    var timeout = new Promise(function (resolve, reject) {
        timer = setTimeout(function () { timedOut = true; if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } reject(new Error('timeout')); }, ms);
    });
    var init = { method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit' };
    if (ctl) init.signal = ctl.signal;
    // A CORS failure (a refusal without CORS headers, an older bridge, a blocked local-network
    // request) and "nothing listens" both reject with a TypeError; a no-cors probe tells them
    // apart: an opaque response means something answered.
    var req = Promise.resolve().then(function () { return f(u.healthUrl, init); }).then(null, function (e) {
        if (timedOut) throw e;
        var init2 = { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit' };
        if (ctl) init2.signal = ctl.signal;
        return Promise.resolve().then(function () { return f(u.healthUrl, init2); }).then(function (r2) {
            if (r2 && (r2.type === 'opaque' || r2.status === 0)) return { opaqueProbe: true };
            throw e;
        }, function () { throw e; });
    });
    function done() { if (timer != null) { clearTimeout(timer); timer = null; } }
    return Promise.race([req, timeout]).then(function (res) {
        done();
        if (res && res.opaqueProbe) return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ', but the browser did not let this page read the reply.', hints: failHints(u, 'opaque') });
        if (res && res.status === 403) {
            return Promise.resolve().then(function () { return res.json(); }).then(null, function () { return null; }).then(function (b) {
                var why = b && (b.error === 'origin' || b.error === 'host') ? b.error : '';
                return Object.assign(base, { ok: false, reachable: true, refused: why || 'unknown',
                    error: why === 'origin' ? 'The bridge at ' + u.healthUrl + ' is running but refused this page (origin not accepted).'
                        : why === 'host' ? 'The bridge at ' + u.healthUrl + ' is running but refused the host name ' + u.host + '.'
                        : 'The bridge at ' + u.healthUrl + ' answered 403 Forbidden.',
                    hints: failHints(u, why || 'forbidden') });
            });
        }
        if (!res || !res.ok) return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ' with HTTP ' + (res ? res.status : '?') + ' — not the WTS Modbus bridge (or an older version).', hints: failHints(u) });
        return Promise.resolve().then(function () { return res.json(); }).then(function (h) {
            if (!h || h.name !== BRIDGE_NAME || typeof h.version !== 'string') {
                return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ' but it is not the WTS Modbus bridge.', hints: failHints(u) });
            }
            var allow = Array.isArray(h.allow) ? h.allow.map(String) : [];
            var devs = devices.map(function (d) { return { name: d.name, target: d.target, allowed: allowedBy(allow, d.host, d.port === '*' ? 502 : d.port) }; });
            var P = pack(), warnings = [];
            if (P && versionLess(h.version, P.version)) warnings.push('Bridge v' + h.version + ' is older than v' + P.version + ' bundled with this app — download the package again and re-run the installer to update.');
            var missing = devs.filter(function (d) { return !d.allowed; });
            if (missing.length) warnings = warnings.concat(['Not in the bridge allow-list: ' + missing.map(function (d) { return d.target; }).join(', ') + ' — this bridge is restricted to a list of devices (an older installer wrote one).'], ALLOW_FIX);
            if (!devices.length) warnings.push('No "Modbus TCP via WebSocket bridge" devices use this bridge yet.');
            return Object.assign(base, { ok: !missing.length, reachable: true, running: true, version: h.version, readOnly: h.readOnly !== false,
                port: h.port, uptimeS: h.uptimeS, allow: allow, devices: devs, warnings: warnings });
        }, function () {
            return Object.assign(base, { ok: false, reachable: true, error: 'Something answered at ' + u.healthUrl + ' but not with the bridge\'s health data.', hints: failHints(u) });
        });
    }, function () {
        done();
        return Object.assign(base, { ok: false, reachable: false, timedOut: timedOut,
            error: timedOut ? 'No answer from ' + u.healthUrl + ' within ' + Math.round(ms / 1000) + ' s.' : 'No bridge answered at ' + u.healthUrl + '.', hints: failHints(u) });
    });
}
function checkBridge(cfg, opts) {
    opts = opts || {};
    var f = opts.fetch || (typeof G.fetch === 'function' ? function (a, b) { return G.fetch(a, b); } : null);
    var t = targetsFromConfig(cfg, '');
    var urls = t.urls.length ? t.urls : [parseBridgeUrl(opts.url || DEFAULT_URL)];
    return Promise.all(urls.map(function (u) {
        var devs = t.targets.filter(function (d) { return !d.extra && (d.url === u.healthUrl || (!d.url && urls.length === 1)); });
        return checkOne(u, devs, f, opts);
    })).then(function (results) {
        return { ok: results.every(function (r) { return r.ok; }), results: results, configErrors: t.errors };
    });
}

G.WTS_modbusBridgeSetup = {
    DEFAULT_URL: DEFAULT_URL, validateTarget: validateTarget, validateListen: validateListen, validHost: validHost, isIPv4: isIPv4, isIPv6: isIPv6,
    validateOrigin: validateOrigin, bridgeAcceptsOrigin: bridgeAcceptsOrigin, pageOrigin: pageOrigin, originNote: originNote, autoOrigins: autoOrigins, shArg: shArg,
    parseBridgeUrl: parseBridgeUrl, targetsFromConfig: targetsFromConfig, buildInstaller: buildInstaller,
    installerFromConfig: installerFromConfig, commandsFor: commandsFor, quickSetup: quickSetup, releaseInstaller: releaseInstaller,
    RELEASE_LATEST: RELEASE_LATEST, EXE_FILE: EXE_FILE, SH_RELEASE_FILE: SH_RELEASE_FILE, zip: zip, crc32: crc32, base64: base64,
    packageZip: packageZip, allowedBy: allowedBy, checkBridge: checkBridge, versionLess: versionLess, pack: pack
};
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis, S = G.WTS_modbusBridgeSetup;
    var ok = !!S && S.validateTarget('192.168.1.10:502').ok && !S.validateTarget('1.2.3.4;rm -rf ~:502').ok && !S.validateTarget('$(calc):502').ok &&
        S.validateTarget('10.0.0.0/24:*').ok && !S.validateTarget('1.2.3.999:502').ok && S.crc32([49, 50, 51, 52, 53, 54, 55, 56, 57]) === 0xCBF43926 &&
        S.base64([77, 97, 110]) === 'TWFu' && S.allowedBy(['10.0.0.0/24:502'], '10.0.0.9', 502) && !S.allowedBy(['10.0.0.0/24:502'], '10.0.1.9', 502);
    if (typeof console !== 'undefined') console[ok ? 'log' : 'warn']('[65-modbus-bridge-setup] self-test ' + (ok ? 'passed' : 'FAILED'));
})();
