// SwiftUI shell for the iPhone bridge. Keep this screen open (or the app in the
// foreground/background with Bluetooth active) while recording; Safari on the
// same phone reads the stream from ws://127.0.0.1:<port>.

import SwiftUI

@main
struct MindGuardBridgeApp: App {
    var body: some Scene {
        WindowGroup {
            BridgeView()
        }
    }
}

struct BridgeView: View {
    @StateObject private var bridge: HeadbandBridge
    private let server: BridgeServer

    @State private var port = "8787"
    @State private var nameFilter = "regul8"
    @State private var channel = "AF7"
    @State private var pairFirst = false
    @State private var appUrl = "https://muse-brain-insight.lovable.app/brainwaves"

    init() {
        let server = BridgeServer()
        self.server = server
        _bridge = StateObject(wrappedValue: HeadbandBridge(server: server))
    }

    private var running: Bool { bridge.state != "idle" && bridge.state != "error" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("State", value: bridge.state.capitalized)
                    LabeledContent("Detail", value: bridge.detail)
                    if let device = bridge.deviceName { LabeledContent("Headband", value: device) }
                    if let firmware = bridge.firmware { LabeledContent("Firmware", value: firmware) }
                    if let battery = bridge.batteryPercent { LabeledContent("Battery", value: "\(battery)%") }
                    LabeledContent("Samples", value: "\(bridge.samplesReceived)")
                } header: {
                    Text("Link")
                }

                Section {
                    TextField("Port", text: $port).keyboardType(.numberPad)
                    TextField("Name contains", text: $nameFilter).autocorrectionDisabled()
                    TextField("Channel", text: $channel).autocorrectionDisabled()
                    Toggle("Send pair command first", isOn: $pairFirst)
                } header: {
                    Text("Settings")
                } footer: {
                    Text("Leave pairing off if the headband is already bonded to this iPhone. Turn it on only if the firmware rejects the start command.")
                }

                Section {
                    Button(running ? "Stop bridge" : "Start bridge") {
                        if running {
                            bridge.stop()
                        } else {
                            bridge.start(
                                port: UInt16(port) ?? 8787,
                                nameFilter: nameFilter,
                                channel: channel,
                                pairFirst: pairFirst
                            )
                        }
                    }
                    if let url = URL(string: appUrl) {
                        Link("Open MindGuard in Safari", destination: url)
                    }
                } footer: {
                    Text("In MindGuard, open Tools → Live brainwaves and connect to ws://127.0.0.1:\(port).")
                }

                Section("Log") {
                    ForEach(bridge.logs.reversed()) { line in
                        Text(line.message)
                            .font(.footnote)
                            .foregroundStyle(line.level == "error" ? .red : line.level == "warn" ? .orange : .secondary)
                    }
                }
            }
            .navigationTitle("MindGuard Bridge")
        }
    }
}
