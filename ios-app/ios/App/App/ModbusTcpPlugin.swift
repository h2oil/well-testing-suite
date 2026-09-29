import Foundation
import Capacitor
import Network

/// Raw TCP sockets for Modbus TCP (Mini WellOS / Modbus page) using Network.framework.
///
/// JS contract (prism-build/50-modbus-core.js, nativeTcpTransport):
///   connect({ host, port, timeoutMs }) -> { id }
///   send({ id, data })          data = base64 Modbus TCP ADU
///   disconnect({ id })
///   events: "data" { id, data (base64) }, "closed" { id, reason }
///
/// Registered in the app target by MainViewController.capacitorDidLoad() — no Swift
/// package, so CapApp-SPM / Package.resolved are unaffected.
/// Info.plist carries NSLocalNetworkUsageDescription (iOS 14+ local-network privacy prompt).
@objc(ModbusTcpPlugin)
public class ModbusTcpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ModbusTcpPlugin"
    public let jsName = "ModbusTcp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise)
    ]

    /// All connection state is touched only on this serial queue.
    private let queue = DispatchQueue(label: "com.h2oil.welltesting.modbus-tcp")
    private var connections: [String: NWConnection] = [:]
    private let maxConnections = 16
    private let maxFrame = 260          // largest Modbus TCP ADU

    @objc func connect(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), !host.isEmpty, host.count <= 253 else {
            call.reject("host is required"); return
        }
        let portNum = call.getInt("port") ?? 502
        guard portNum > 0, portNum < 65536, let port = NWEndpoint.Port(rawValue: UInt16(portNum)) else {
            call.reject("port must be 1-65535"); return
        }
        let timeoutMs = max(500, min(call.getInt("timeoutMs") ?? 3000, 30000))
        queue.async {
            if self.connections.count >= self.maxConnections {
                call.reject("too many open Modbus connections"); return
            }
            let tcp = NWProtocolTCP.Options()
            tcp.noDelay = true
            tcp.connectionTimeout = max(1, timeoutMs / 1000)
            let params = NWParameters(tls: nil, tcp: tcp)
            let conn = NWConnection(host: NWEndpoint.Host(host), port: port, using: params)
            let id = UUID().uuidString
            var settled = false
            let settle: (Bool, String?) -> Void = { ok, err in
                if settled { return }
                settled = true
                if ok {
                    self.connections[id] = conn
                    call.resolve(["id": id])
                    self.receive(id, conn)
                } else {
                    conn.cancel()
                    call.reject(err ?? "connection failed")
                }
            }
            conn.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    settle(true, nil)
                case .waiting(let error):
                    // e.g. no route, or Local Network permission not granted
                    settle(false, "cannot reach \(host):\(portNum) — \(error.localizedDescription)")
                case .failed(let error):
                    if settled { self.closed(id, reason: error.localizedDescription) }
                    else { settle(false, error.localizedDescription) }
                case .cancelled:
                    if settled { self.closed(id, reason: "closed") }
                default:
                    break
                }
            }
            conn.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
                settle(false, "connect to \(host):\(portNum) timed out")
            }
        }
    }

    private func receive(_ id: String, _ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                self.notifyListeners("data", data: ["id": id, "data": data.base64EncodedString()])
            }
            if isComplete || error != nil {
                self.closed(id, reason: error?.localizedDescription ?? "peer closed the connection")
                conn.cancel()
                return
            }
            self.receive(id, conn)
        }
    }

    private func closed(_ id: String, reason: String) {
        // called on `queue`
        if connections.removeValue(forKey: id) != nil {
            notifyListeners("closed", data: ["id": id, "reason": reason])
        }
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let b64 = call.getString("data"),
              let payload = Data(base64Encoded: b64), !payload.isEmpty, payload.count <= maxFrame else {
            call.reject("id and a base64 Modbus frame (1-260 bytes) are required"); return
        }
        queue.async {
            guard let conn = self.connections[id] else { call.reject("connection is not open"); return }
            conn.send(content: payload, completion: .contentProcessed { error in
                if let error = error { call.reject("send failed: \(error.localizedDescription)") } else { call.resolve() }
            })
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        queue.async {
            if let conn = self.connections.removeValue(forKey: id) { conn.cancel() }
            call.resolve()
        }
    }
}
