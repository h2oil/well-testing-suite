import UIKit
import Capacitor

/// Bridge view controller for the app (Main.storyboard custom class).
/// Registers app-local Capacitor plugins that live in the App target rather than in a
/// Swift package (Capacitor 8 "custom native iOS code"), so the SPM wiring
/// (CapApp-SPM/Package.swift, Package.resolved) does not change.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ModbusTcpPlugin())
    }
}
