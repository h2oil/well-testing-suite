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
- Connects **only** to the host:port pairs you allow with `--allow`.
- **Read-only by default:** Modbus write requests (function codes 05, 06, 15, 16) are answered
  by the bridge with exception 01 (Illegal function) and never reach the device, unless you start
  it with `--allow-writes`. Writes also have to be enabled on the Modbus page and confirmed there.
- Accepts browser connections only from `http(s)://localhost`, `http(s)://127.0.0.1`, `file://`,
  `https://pb-handbook.com` and the iOS app origin, unless you add `--origin https://your-host`
  (or `--any-origin`). Browsers allow an https page to open `ws://127.0.0.1`, so the bridge URL
  stays `ws://127.0.0.1:8502` even when the app is served over https.

## Install Node.js

- **Windows:** install the LTS version from <https://nodejs.org> (or `winget install OpenJS.NodeJS.LTS`).
- **macOS:** `brew install node`, or the installer from <https://nodejs.org>.
- **Linux:** your distribution's `nodejs` package (18+), or <https://nodejs.org>.

Check with `node --version`.

## Run

From the repository folder (or copy the `tools/modbus-bridge` folder anywhere):

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
`ws://127.0.0.1:8502`. Press **Test** on the device row.

### Options

| Option | Meaning |
|---|---|
| `--allow host:port` | Allow a target. Repeat for several. `host:*` allows any port; `10.0.0.0/24:502` allows an IPv4 subnet. |
| `--port 8502` | WebSocket port. |
| `--listen 127.0.0.1` | Interface to listen on. Anything other than localhost lets other machines use the bridge — only do this on a trusted network. |
| `--origin https://example.com` | Also accept pages served from this origin (repeat as needed). |
| `--any-origin` | Accept any page origin (not recommended). |
| `--allow-writes` | Forward Modbus write requests (FC 05 / 06 / 15 / 16). |
| `--verbose` | Log connections and blocked requests. |

Example with two PLCs and writes enabled:
```
node tools/modbus-bridge/modbus-bridge.js --allow 192.168.1.10:502 --allow 192.168.1.11:502 --allow-writes
```

## Test without hardware

`fake-slave.js` is a tiny Modbus TCP slave (unit 1) for trying the bridge:
```
node tools/modbus-bridge/fake-slave.js --port 5020
node tools/modbus-bridge/modbus-bridge.js --allow 127.0.0.1:5020
```
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
- References: RFC 6455 (WebSocket), MODBUS Messaging on TCP/IP Implementation Guide V1.0b,
  MODBUS Application Protocol Specification V1.1b3.

## Troubleshooting

- *"Cannot reach the Modbus bridge"* — the bridge is not running, or the URL / port differs.
- *"not in the bridge allow-list"* — restart the bridge with `--allow <host>:<port>` for that device.
- *HTTP 403 in the browser console* — the page is served from an origin the bridge does not
  accept; add `--origin <that origin>`.
- *Timeouts* — check the unit id (many gateways need the RS-485 slave address here), the IP /
  port, and that no firewall blocks TCP 502 between the PC and the device.
- *Exception 01 on writes* — the bridge is read-only; start it with `--allow-writes`.
