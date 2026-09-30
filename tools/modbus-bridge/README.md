# Modbus bridge (WebSocket ↔ Modbus TCP)

Web browsers cannot open raw TCP sockets, so the web build of the Well Testing Suite reaches
Modbus TCP equipment (PLCs, RTUs, flow computers, serial-to-Ethernet gateways) through this small
bridge. It runs on a PC on the same network as the equipment. The iOS app does not need it (it has
a native TCP plugin), and Modbus RTU over RS-485 uses Web Serial directly in Chrome / Edge.

```
Modbus page / Mini WellOS ──ws://127.0.0.1:8502──► modbus-bridge.js ──TCP 502──► PLC / RTU / gateway
```

- Zero dependencies, one file: `modbus-bridge.js` (Node.js 18 or newer).
- Listens on **127.0.0.1 only** by default.
- Reaches **any device IP address / port** by default (since v1.2.0: an empty allow-list means
  `*:*`); list `--allow host:port` targets to restrict it to those.
- **Read-only by default:** Modbus write requests (function codes 05, 06, 15, 16) are answered
  by the bridge with exception 01 (Illegal function) and never reach the device, unless you start
  it with `--allow-writes`. Writes also have to be enabled on the Modbus page and confirmed there.
- Accepts browser connections only from `http(s)://localhost`, `http(s)://127.0.0.1`,
  `https://pb-handbook.com` and the iOS app origin, unless you add `--origin https://your-host`
  (or `--any-origin`). Browsers allow an https page to open `ws://127.0.0.1`, so the bridge URL
  stays `ws://127.0.0.1:8502` even when the app is served over https.
- **Saved copies of the app** (opened from a `file://` path) send `Origin: null`. The bridge
  refuses that by default, because any web site can send `null` too (from a sandboxed frame).
  Prefer opening the app from `https://pb-handbook.com` or `http://localhost`; if you must use a
  saved copy, allow it explicitly with `--origin null` (installer: `--origin null` / `-Origin null`,
  or `"origins": ["null"]` in `bridge-config.json`) — only on a PC that is not used for general
  web browsing.

The app's **Modbus Config** page has the same steps as a guide (Connecting to real equipment →
bridge setup): it downloads this folder as a zip (bundled in the app, works offline), generates an
installer pre-filled with your configured bridge devices, and checks the running bridge.

## One-click install (recommended)

The GitHub releases of this repository carry ready-made installers
(built and tested by `.github/workflows/modbus-bridge-release.yml`):

**Windows** — download and double-click
[WTS-Modbus-Bridge-Setup.exe](https://github.com/h2oil/well-testing-suite/releases/latest/download/WTS-Modbus-Bridge-Setup.exe):

```
https://github.com/h2oil/well-testing-suite/releases/latest/download/WTS-Modbus-Bridge-Setup.exe
```

- No administrator rights and no Node.js needed (the exe carries Node.js; a Node.js single
  executable application with no console window).
- It copies itself to `%LOCALAPPDATA%\WTS Modbus Bridge\WTS-Modbus-Bridge.exe`, keeps an existing
  `bridge-config.json` there (or writes the default: any device IP / port, read-only, port 8502),
  stops an earlier copy, registers auto-start at login for the current user
  (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value "WTS Modbus Bridge"), adds the
  Start-menu shortcuts **WTS Modbus Bridge — status** and **Uninstall WTS Modbus Bridge** and an
  entry in Settings → Apps, starts the bridge and opens its status page `http://127.0.0.1:8502/`.
- The exe is **code-signed** by H2Oil Engineering (release workflow; see the signing secrets at the
  top of `.github/workflows/modbus-bridge-release.yml`). While a new certificate builds reputation,
  SmartScreen may still say "Windows protected your PC": click **More info**, check the publisher,
  then **Run anyway**.
- Uninstall: Settings → Apps → Installed apps → **WTS Modbus Bridge** → Uninstall (or the
  Start-menu shortcut).
- Command line (`WTS-Modbus-Bridge.exe` in the install folder, or the setup exe): `--run` (what the
  login entry starts; single instance), `--open` (start if needed, open the status page),
  `--status` (JSON), `--uninstall`, `--version`, and the settings `--allow host:port`,
  `--allow-any`, `--allow-writes`, `--read-only`, `--port N`, `--no-autostart` (the bridge is
  restarted with them), `--no-browser` / `--quiet` (no browser page, no message boxes). The exe
  is a GUI program, so its console output is only seen when redirected
  (`WTS-Modbus-Bridge.exe --status > status.txt`). Log: `bridge.log` in the install folder.

**macOS / Linux** — in a Terminal:

```
curl -fsSL https://github.com/h2oil/well-testing-suite/releases/latest/download/wts-modbus-bridge-install.sh | bash -s -- --autostart --yes
```

This is `install.sh` with the bridge files built in (SHA-256 checked when unpacked). `--autostart`
starts the bridge now and at every login (a LaunchAgent / a systemd `--user` service); `--yes`
lets it install Node.js 18+ with Homebrew or the package manager when it is missing. Add
`--port N`, `--allow-writes` or `--allow host:port` as for `install.sh` below.

Then press **Check bridge** on the app's Modbus Config page.

### Cutting a release (maintainers)

The tag must match `BRIDGE_VERSION` in `modbus-bridge.js`:

```
git tag modbus-bridge-v1.2.0 && git push origin modbus-bridge-v1.2.0
```

The workflow builds `WTS-Modbus-Bridge-Setup.exe` on `windows-latest` (Node 22,
`tools/modbus-bridge/exe/build-exe.js`: bundle → SEA blob → `postject` into a copy of `node.exe`
with its signature stripped → PE subsystem patched to WINDOWS_GUI) and smoke-tests it
(`exe/ci-smoke-exe.js`: install with `--no-browser` into a temp `LOCALAPPDATA`, `/health`, the Run
value, single instance, settings, `--uninstall`); on `ubuntu-latest` it builds
`wts-modbus-bridge-install.sh` and `wts-modbus-bridge-<version>.zip`
(`exe/build-release-scripts.js`, the same generator as the app) and runs the installer piped into
bash end to end (`exe/test-release-sh.js`). The release job attaches the three files and
`SHA256SUMS.txt` to the GitHub Release for the tag and marks it **latest**, which is what the
`/releases/latest/download/…` links resolve to. "Run workflow" (workflow_dispatch) builds and
tests without releasing. Locally: `node tools/modbus-bridge/exe/build-exe.js --download` builds the
exe on any OS (it downloads `node.exe` of the running Node version from nodejs.org, SHA-256
checked); it can only be run on Windows.

## Script install

The installers need **no administrator rights** for the bridge. They check for Node.js 18+ and, if
it is missing, offer to install it with the system package manager — only after you confirm.
Nothing else is downloaded. Every `host:port` is validated (IPv4, IPv4 subnet `a.b.c.d/nn`, a
host name of letters, digits, dots, hyphens and underscores, or an IPv6 address in brackets such as
`[fd00::10]:502`; port 1-65535 or `*`).

### Windows (PowerShell 5.1 or 7)

In the unzipped folder, open PowerShell (Start menu → type PowerShell, or right-click the folder
with Shift → "Open PowerShell window here") and run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -Allow "192.168.1.10:502,192.168.1.11:502"
```

`-ExecutionPolicy Bypass` applies to this one run only (it changes no system setting and is what
lets a downloaded script run). The installer:

- copies the bridge to `%LOCALAPPDATA%\WTS Modbus Bridge`, writes `bridge-config.json` and
  `start-bridge.cmd` there, and adds a Start-menu shortcut **WTS Modbus Bridge**;
- offers `winget install OpenJS.NodeJS.LTS` if Node.js is missing (Windows may ask for permission);
- starts the bridge in its own window (leave it open), checks `http://127.0.0.1:8502/health` and
  prints the next steps.

Options: `-Port 8502`, `-Listen 127.0.0.1`, `-AllowWrites` / `-ReadOnly`, `-Origin https://my.site`,
`-AutoStart` (start at every logon: a user-level Scheduled Task, or a Startup-folder shortcut when
Task Scheduler refuses), `-NoStart`, `-Reset`, `-Yes` (answer yes to the Node.js question),
`-Uninstall`.

### macOS and Linux

In the unzipped folder, in a Terminal:

```
bash install.sh --allow 192.168.1.10:502 --allow 192.168.1.11:502
```

(`--allow` can be repeated or take a comma list. Quote targets that contain `*` or `[ ]`, e.g.
`--allow 'plc-2.local:*'` — zsh, the macOS default shell, stops with "no matches found" otherwise.)
The installer:

- copies the bridge to `~/Library/Application Support/WTS Modbus Bridge` (macOS) or
  `${XDG_DATA_HOME:-~/.local/share}/wts-modbus-bridge` (Linux), and writes `bridge-config.json`
  and `start-bridge.sh` there;
- offers `brew install node` (macOS) or the distribution's `nodejs` package (Linux, via sudo) if
  Node.js is missing — check that it is version 18 or newer, otherwise use <https://nodejs.org>;
- starts the bridge **in that Terminal window** (leave it open; Ctrl+C stops it), checks
  `/health` and prints the next steps.

Options: `--port 8502`, `--listen 127.0.0.1`, `--allow-writes` / `--read-only`,
`--origin https://my.site`, `--autostart`, `--no-start`, `--reset`, `--yes`, `--uninstall`.

`--autostart` starts the bridge now and at every login instead of in the Terminal (with
`--no-start` it is only set up, and starts at the next login):

- **macOS:** a LaunchAgent `~/Library/LaunchAgents/uk.co.h2oil.wts-modbus-bridge.plist`
  (log: `bridge.log` in the install folder).
- **Linux:** a systemd user service `wts-modbus-bridge.service`
  (`systemctl --user status wts-modbus-bridge`, `journalctl --user -u wts-modbus-bridge`; to keep it
  running while logged out: `loginctl enable-linger "$USER"`). Where `systemd --user` is not
  available (WSL, containers, SSH-only sessions) the installer says so and runs the bridge in the
  Terminal instead; add `start-bridge.sh` to your desktop's startup applications or to
  `crontab -e` as `@reboot "/path/to/start-bridge.sh"`.

### Running the installer again

Running an installer again (the package's, the one generated by the app, or the copy in the install
folder) updates the files and **keeps the existing `bridge-config.json`**: new `--allow` / `-Allow`
targets are **added** to its allow list, and its port, listen address, write setting and origins
stay unless you give `--port`, `--listen`, `--allow-writes` / `--read-only` (`-Port`, `-Listen`,
`-AllowWrites` / `-ReadOnly`) or `--origin`. So adding one more device is just:

```
bash "$HOME/Library/Application Support/WTS Modbus Bridge/install.sh" --allow 192.168.1.12:502   # macOS
bash "${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh" --allow 192.168.1.12:502 # Linux
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\WTS Modbus Bridge\install-windows.ps1" -Allow "192.168.1.12:502"
```

`--reset` / `-Reset` starts from a new, empty configuration instead. The previous file is kept as
`bridge-config.json.bak`. Before writing anything the installer stops the bridge it started earlier
(a Terminal / window started by an earlier install, or the auto-start service) and checks that the
port is free — if another bridge or program answers there, it stops with a message and changes
nothing.

### Installer generated by the app

**Modbus Config → Connecting to real equipment → Generate installer for my devices** downloads a
single script (`wts-modbus-bridge-install.ps1` or `wts-modbus-bridge-install.sh`) with the bridge
files embedded (SHA-256 checked when unpacked), the `--allow` targets taken from your
"Modbus TCP via WebSocket bridge" devices, the bridge port from their bridge URL and the read-only /
writes choice made on the page (when the app is served from a site the bridge does not accept by
default, that origin is added too). Run it with:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\wts-modbus-bridge-install.ps1"
bash ~/Downloads/wts-modbus-bridge-install.sh
```

Extra options on the command line are added to the built-in ones, and the targets of an existing
`bridge-config.json` are kept (see above).

### Uninstall

```
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\WTS Modbus Bridge\install-windows.ps1" -Uninstall
bash "$HOME/Library/Application Support/WTS Modbus Bridge/install.sh" --uninstall       # macOS
bash "${XDG_DATA_HOME:-$HOME/.local/share}/wts-modbus-bridge/install.sh" --uninstall     # Linux
```

This stops the bridge, removes the auto-start entry and shortcuts, and deletes the installed files
(a folder that still contains other files is left in place).

## Configuration file

The installers write `bridge-config.json`; the bridge reads it with `--config`:

```json
{
  "_comment": "keys starting with _ are ignored",
  "allow": ["192.168.1.10:502", "10.0.0.0/24:502", "plc-2.local:*", "[fd00::10]:502"],
  "port": 8502,
  "listen": "127.0.0.1",
  "origins": [],
  "anyOrigin": false,
  "allowWrites": false,
  "verbose": false
}
```

All keys are optional. Command-line flags override `port` / `listen` and add to the `allow` /
`origins` lists; `--allow-writes`, `--any-origin` and `--verbose` switch those on. Restart the
bridge after editing (Windows: close its window and use the Start-menu shortcut; macOS / Linux:
Ctrl+C and `start-bridge.sh`, or re-run the installer for an auto-start bridge).

## Run it by hand

In the **unzipped package folder** (`wts-modbus-bridge`, from the app), on any system:
```
node modbus-bridge.js --allow 192.168.1.10:502
```

From the **repository** folder:

**Windows (PowerShell or cmd)**
```
node tools\modbus-bridge\modbus-bridge.js --allow 192.168.1.10:502
```

**macOS / Linux**
```
node tools/modbus-bridge/modbus-bridge.js --allow 192.168.1.10:502
```

It prints `listening on ws://127.0.0.1:8502/modbus (read-only)`. Leave the window open while you use
Mini WellOS. Stop it with Ctrl+C.

Then, on the **Modbus** page of the app, add a device with transport
"Modbus TCP via WebSocket bridge", host `192.168.1.10`, port `502`, the unit id, and bridge URL
`ws://127.0.0.1:8502`. Press **Check bridge** in the setup guide, then **Test** on the device row.

### Options

| Option | Meaning |
|---|---|
| `--allow host:port` | Allow a target. Repeat for several. `'host:*'` allows any port; `10.0.0.0/24:502` allows an IPv4 subnet; `'[fd00::10]:502'` an IPv6 address. Quote values with `*` or `[ ]` in sh / zsh. |
| `--port 8502` | WebSocket port. |
| `--listen 127.0.0.1` | Interface to listen on. Anything other than localhost lets other machines use the bridge — only do this on a trusted network. |
| `--origin https://example.com` | Also accept pages served from this origin (repeat as needed). `--origin null` accepts a saved `file://` copy of the app — and any web site's sandboxed frames, so only on a PC not used for general browsing. |
| `--any-origin` | Accept any page origin (not recommended). |
| `--allow-writes` | Forward Modbus write requests (FC 05 / 06 / 15 / 16). |
| `--config file.json` | Read settings from a configuration file (see above). |
| `--verbose` | Log connections and blocked requests. |
| `--version` | Print the bridge version. |

Example with two PLCs and writes enabled (in the package folder):
```
node modbus-bridge.js --allow 192.168.1.10:502 --allow 192.168.1.11:502 --allow-writes
```

## Health check

`GET http://127.0.0.1:8502/health` returns

```json
{"name":"wts-modbus-bridge","version":"1.1.0","readOnly":true,"port":8502,"uptimeS":42,"allow":["192.168.1.10:502"]}
```

The app's **Check bridge** button uses it to show whether the bridge runs, its version, whether it
is read-only and whether each configured device is in the allow-list. The health data (with CORS
headers) goes only to the page origins the bridge accepts (the same rules as the WebSocket
connection) and to requests without an `Origin` header (`curl http://127.0.0.1:8502/health` works
from the same PC). A refused request gets `403 {"error":"origin"}` — or `{"error":"host"}` when the
`Host` is not localhost, an IP address or the `--listen` name and the request has no accepted
`Origin` (protection against DNS rebinding) — with `Access-Control-Allow-Origin` echoed, so
**Check bridge** can say why instead of "no bridge answered". The refusal contains nothing else, and
a refused preflight is never approved for local-network access.

**Chrome / Edge and local-network access:** when the app is served from a public https site,
Chromium browsers treat a request to `127.0.0.1` as a private-network request. The bridge answers
the CORS preflight with `Access-Control-Allow-Private-Network: true`, and newer versions may show a
prompt asking to let the site access apps or devices on your local network — choose **Allow**.
Other browsers may block an https page from reaching `http://127.0.0.1`; use Chrome / Edge, or open
the app from `http://localhost` (a saved `file://` copy needs `--origin null`, see above).

## Test without hardware

`fake-slave.js` is a tiny Modbus TCP slave (unit 1) for trying the bridge. In the unzipped package
folder, in two windows:
```
node fake-slave.js --port 5020
node modbus-bridge.js --allow 127.0.0.1:5020
```
(from the repository: `node tools/modbus-bridge/fake-slave.js --port 5020` and
`node tools/modbus-bridge/modbus-bridge.js --allow 127.0.0.1:5020`).
Holding register *n* holds *n*, input register *n* holds 1000 + *n*, and input registers 100-101
hold the FLOAT32 value 123.456 (ABCD). In the app, add a bridge device with host `127.0.0.1`,
port `5020`, and a tag on input register 100, type FLOAT32.

The app also has a built-in virtual slave ("Built-in simulator" transport, or **Load simulator
demo** on the Modbus page) that needs neither the bridge nor Node.

## Protocol (for developers)

- The page opens one WebSocket per device: `ws://127.0.0.1:8502/modbus?host=<ip>&port=<port>`.
- When the TCP connection to the device is up, the bridge sends the text message
  `{"type":"open"}`. Errors arrive as `{"type":"error","message":"…"}` followed by a close
  (1008 = target not allowed, 1011 = connection error).
- Binary messages carry complete Modbus TCP ADUs (MBAP header + PDU) in both directions; the
  bridge re-frames the device's TCP stream using the MBAP length field. ADUs are limited to
  260 bytes; fragmented WebSocket messages are refused.
- `GET /health` (and its CORS preflight) as described above; any other plain HTTP request gets a
  short text banner.
- References: RFC 6455 (WebSocket), MODBUS Messaging on TCP/IP Implementation Guide V1.0b,
  MODBUS Application Protocol Specification V1.1b3.

## Troubleshooting

- *"Cannot reach the Modbus bridge"* — the bridge is not running, the URL / port differs, or the
  bridge refused the page (a browser reports all three the same way). Press **Check bridge** on the
  Modbus page: it says which.
- *Windows: "Windows protected your PC"* — SmartScreen, while the signing
  certificate of `WTS-Modbus-Bridge-Setup.exe` builds reputation: click **More info**, check the
  publisher is H2Oil Engineering, then **Run anyway**.
- *"not in the bridge allow-list"* — the bridge was restricted to a list of targets (an empty
  list allows any device): run the installer again with that device
  (`--allow <host>:<port>` / `-Allow`): it is added to the targets already allowed. Or add it to
  `allow` in `bridge-config.json` and restart the bridge.
- *"the bridge refused this page" / origin not accepted* — the page is served from an origin the
  bridge does not accept: run the installer again with `--origin <that origin>` (`-Origin`), or add
  it to `origins` in `bridge-config.json`. A saved `file://` copy sends `null` (see the top of
  this file).
- *"refused the host name"* — the device bridge URL uses a host name the bridge does not know: use
  the bridge PC's IP address in the bridge URL.
- *zsh: no matches found* — quote targets with `*` or `[ ]`: `--allow 'plc-2.local:*'`.
- *Timeouts* — check the unit id (many gateways need the RS-485 slave address here), the IP /
  port, and that no firewall blocks TCP 502 between the PC and the device.
- *Exception 01 on writes* — the bridge is read-only; run the installer again with `--allow-writes` /
  `-AllowWrites` (the targets and the port are kept).
- *Chrome / Edge asks about local network access* — choose Allow (see "Health check" above).
- *Windows: "running scripts is disabled on this system"* — use the
  `powershell -NoProfile -ExecutionPolicy Bypass -File …` command exactly as shown.
- *macOS / Linux: "permission denied"* — start the installer with `bash install.sh …`.
- *Port 8502 already in use* — install with `--port` / `-Port` and change the device bridge URL to
  match (the port is then kept when you run the installer again).
- *Listening on `localhost`* — the installers and the bridge treat `localhost` as `127.0.0.1`
  (on macOS / Windows `localhost` can resolve to `::1` only, which `ws://127.0.0.1` cannot reach).
