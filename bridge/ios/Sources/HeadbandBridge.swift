// CoreBluetooth central for iOS. Identical activation logic to the macOS
// bridge, but published as an ObservableObject so the SwiftUI screen can show
// the link state, and with iOS-specific wording for permissions.

import Combine
import CoreBluetooth
import Foundation

struct BridgeLogLine: Identifiable {
    let id = UUID()
    let level: String
    let message: String
    let at = Date()
}

final class HeadbandBridge: NSObject, ObservableObject {
    @Published private(set) var state = "idle"
    @Published private(set) var detail = "Not started."
    @Published private(set) var deviceName: String?
    @Published private(set) var firmware: String?
    @Published private(set) var batteryPercent: Int?
    @Published private(set) var samplesReceived = 0
    @Published private(set) var logs: [BridgeLogLine] = []

    private var central: CBCentralManager?
    private let server: BridgeServer
    private var nameFilter = "regul8"
    private var channel = "AF7"

    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private let deframer = Deframer()
    private var messageId: UInt64 = 0
    private var handshakeStep = 0
    private var skipPair = true
    private var helloSent = false
    private var lastDataAt = Date()
    private var watchdog: DispatchSourceTimer?
    private var running = false

    init(server: BridgeServer) {
        self.server = server
        super.init()
    }

    // MARK: - Lifecycle

    func start(port: UInt16, nameFilter: String, channel: String, pairFirst: Bool) {
        self.nameFilter = nameFilter.lowercased()
        self.channel = channel
        skipPair = !pairFirst
        do {
            try server.start(port: port)
        } catch {
            set(state: "error", detail: "Could not listen on port \(port). Try another port.")
            log("error", "Listener failed: \(error.localizedDescription)")
            return
        }
        running = true
        log("info", "Bridge listening on ws://127.0.0.1:\(port)")
        set(state: "starting", detail: "Waiting for Bluetooth…")
        if central == nil {
            // Restoration lets iOS hand the link back if the app is suspended.
            central = CBCentralManager(
                delegate: self,
                queue: nil,
                options: [CBCentralManagerOptionRestoreIdentifierKey: "mindguard.bridge.central"]
            )
        } else {
            centralManagerDidUpdateState(central!)
        }
        startWatchdog()
    }

    func stop() {
        running = false
        watchdog?.cancel()
        watchdog = nil
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        central?.stopScan()
        peripheral = nil
        writeChar = nil
        helloSent = false
        deframer.reset()
        server.stop()
        set(state: "idle", detail: "Stopped.")
    }

    // MARK: - Publishing

    private func set(state: String, detail: String) {
        DispatchQueue.main.async {
            self.state = state
            self.detail = detail
        }
        server.broadcast(["type": "status", "state": state, "reason": detail])
    }

    private func log(_ level: String, _ message: String) {
        DispatchQueue.main.async {
            self.logs.append(BridgeLogLine(level: level, message: message))
            if self.logs.count > 200 { self.logs.removeFirst(self.logs.count - 200) }
        }
        server.broadcast(["type": "log", "level": level, "message": message])
    }

    /// Restarts the handshake when the band goes quiet: a silent link must never
    /// be reported to the app as a healthy connection.
    private func startWatchdog() {
        watchdog?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self, self.running, let peripheral = self.peripheral else { return }
            if Date().timeIntervalSince(self.lastDataAt) > 12 {
                self.log("warn", "No EEG for 12 s — restarting the handshake.")
                self.set(state: "reconnecting", detail: "The headband stopped sending data.")
                self.central?.cancelPeripheralConnection(peripheral)
            }
        }
        timer.resume()
        watchdog = timer
    }

    private func nextId() -> UInt64 {
        messageId += 1
        return messageId
    }

    private func write(_ data: Data, _ label: String) {
        guard let peripheral, let writeChar else {
            log("error", "No writable command characteristic.")
            return
        }
        let type: CBCharacteristicWriteType = writeChar.properties.contains(.write) ? .withResponse : .withoutResponse
        peripheral.writeValue(data, for: writeChar, type: type)
        log("info", "→ \(label) (id \(messageId), \(data.count) bytes)")
    }

    /// Pair (unless the band is already bonded) → prepare → start EEG → sync.
    private func advanceHandshake() {
        guard running else { return }
        handshakeStep += 1
        switch handshakeStep {
        case 1:
            if skipPair {
                log("info", "Skipping pair — the band is already bonded to this iPhone.")
                advanceHandshake()
            } else {
                write(CMSN.pairCommand(id: nextId(), identity: CMSN.identityBytes(hex: CMSN.knownIdentity)), "pair")
                schedule()
            }
        case 2:
            write(CMSN.opCommand(id: nextId(), op: CMSN.opPrepare), "prepare session")
            schedule()
        case 3:
            write(CMSN.opCommand(id: nextId(), op: CMSN.opStartEeg), "start EEG stream")
            schedule(after: 0.6)
        case 4:
            write(CMSN.syncCommand(id: nextId(), epochMs: UInt64(Date().timeIntervalSince1970 * 1000)), "clock sync")
        default:
            break
        }
    }

    private func schedule(after seconds: Double = 0.35) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.advanceHandshake() }
    }

    private func handleNotification(_ data: Data) {
        for payload in deframer.push(data) {
            if let eeg = eegSamples(payload) {
                lastDataAt = Date()
                sendHelloIfNeeded()
                let microvolts = eeg.counts.map { Double($0) * CMSN.uvPerCount }
                DispatchQueue.main.async { self.samplesReceived += microvolts.count }
                server.broadcast([
                    "type": "samples",
                    "seq": Int(eeg.seq),
                    "channels": [channel: microvolts],
                ])
            } else if let ack = ackFields(payload) {
                let ok = (ack.result ?? 1) == 0
                log(ok ? "info" : "warn", "← ack op \(ack.op.map(String.init) ?? "?") result \(ack.result.map(String.init) ?? "?")")
            }
        }
    }

    private func sendHelloIfNeeded() {
        guard !helloSent else { return }
        helloSent = true
        server.broadcast([
            "type": "hello",
            "device": peripheral?.name ?? "Regul8 Headband",
            "firmware": firmware ?? "unknown",
            "channels": [channel],
            "sampleRate": CMSN.sampleRate,
            "unit": "uV",
        ])
        set(state: "connected", detail: "EEG streaming.")
        log("info", "EEG streaming — decoded samples are on the WebSocket.")
    }
}

// MARK: - CBCentralManagerDelegate

extension HeadbandBridge: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard running else { return }
        switch central.state {
        case .poweredOn:
            set(state: "scanning", detail: "Looking for the headband…")
            log("info", "Scanning for a headband matching “\(nameFilter)”.")
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        case .unauthorized:
            set(state: "error", detail: "Bluetooth permission denied.")
            log("error", "Allow Bluetooth for this app in Settings → Privacy & Security → Bluetooth.")
        case .poweredOff:
            set(state: "error", detail: "Bluetooth is off.")
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        if let restored = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first {
            peripheral = restored
            restored.delegate = self
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = (peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "").lowercased()
        guard !name.isEmpty, name.contains(nameFilter) else { return }
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        DispatchQueue.main.async { self.deviceName = peripheral.name ?? name }
        log("info", "Found “\(peripheral.name ?? name)” (RSSI \(RSSI)). Connecting…")
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        // CoreBluetooth negotiates the encrypted/bonded link as soon as an
        // encrypted characteristic is touched — the step the browser cannot do.
        deframer.reset()
        messageId = 0
        handshakeStep = 0
        lastDataAt = Date()
        set(state: "handshaking", detail: "Connected. Discovering services…")
        peripheral.discoverServices([CMSN.service, CMSN.deviceInfo, CMSN.batteryService])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log("error", "Connect failed: \(error?.localizedDescription ?? "unknown"). Rescanning.")
        set(state: "reconnecting", detail: "Connect failed.")
        central.scanForPeripherals(withServices: nil, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard running else { return }
        log("warn", "Link lost: \(error?.localizedDescription ?? "clean disconnect").")
        set(state: "reconnecting", detail: "The headband disconnected.")
        writeChar = nil
        helloSent = false
        // Alternate the pair/skip-pair path so a stale bond cannot wedge us.
        skipPair.toggle()
        central.connect(peripheral, options: nil)
    }
}

// MARK: - CBPeripheralDelegate

extension HeadbandBridge: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case CMSN.notify:
                peripheral.setNotifyValue(true, for: characteristic)
            case CMSN.write:
                writeChar = characteristic
            case CMSN.firmwareRevision:
                peripheral.readValue(for: characteristic)
            case CMSN.batteryLevel:
                peripheral.readValue(for: characteristic)
                peripheral.setNotifyValue(true, for: characteristic)
            default:
                break
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == CMSN.notify else { return }
        if let error {
            log("error", "Could not subscribe to the data characteristic: \(error.localizedDescription)")
            return
        }
        // The firmware drops the link if commands arrive before the subscription
        // has settled, so wait briefly and then walk the activation sequence.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.advanceHandshake() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let value = characteristic.value else { return }
        switch characteristic.uuid {
        case CMSN.firmwareRevision:
            let text = String(data: value, encoding: .utf8)
            DispatchQueue.main.async { self.firmware = text }
            log("info", "Firmware \(text ?? "unknown").")
        case CMSN.batteryLevel:
            if let percent = value.first {
                DispatchQueue.main.async { self.batteryPercent = Int(percent) }
                server.broadcast(["type": "battery", "percent": Int(percent)])
            }
        case CMSN.notify:
            handleNotification(value)
        default:
            break
        }
    }
}
