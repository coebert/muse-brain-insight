// MindGuard / CortexTrace macOS CoreBluetooth bridge.
//
// Why this exists: Web Bluetooth cannot initiate an authenticated (bonded,
// encrypted) link, and the FocusCalm / Regul8 FC-11 headband closes the GATT
// connection when vendor CMSN commands arrive on an unencrypted link. macOS
// CoreBluetooth does establish that link, so this process owns the radio and
// republishes decoded EEG to the browser over a plain localhost WebSocket.
//
// Protocol emitted to the app (one JSON object per WebSocket text message):
//   {"type":"hello","device":"Regul8 Headband","firmware":"1.1.6",
//    "channels":["AF7"],"sampleRate":250,"unit":"uV"}
//   {"type":"samples","seq":42,"channels":{"AF7":[12.4,-3.1, ...]}}
//   {"type":"battery","percent":88}
//   {"type":"status","state":"connected"|"scanning"|"reconnecting"|"lost",
//    "reason":"…"}
//   {"type":"log","level":"info"|"warn"|"error","message":"…"}
//
// Run:  swift bridge/macos/MindGuardBridge.swift [--port 8787] [--name Regul8]
// See README.md in this directory.

import CoreBluetooth
import Foundation
import Network

// MARK: - CMSN protocol (ported from src/lib/eeg/focuscalm-cmsn.ts)

enum CMSN {
    static let service = CBUUID(string: "0D740001-D26F-4DBB-95E8-A4F5C55C57A9")
    static let write = CBUUID(string: "0D740002-D26F-4DBB-95E8-A4F5C55C57A9")
    static let notify = CBUUID(string: "0D740003-D26F-4DBB-95E8-A4F5C55C57A9")

    static let deviceInfo = CBUUID(string: "180A")
    static let firmwareRevision = CBUUID(string: "2A26")
    static let batteryService = CBUUID(string: "180F")
    static let batteryLevel = CBUUID(string: "2A19")

    static let sampleRate = 250.0
    /// Microvolts per raw count (Vref 4.5 V, gain 24).
    static let uvPerCount = 0.0223517

    static let opPair: UInt64 = 2
    static let opPrepare: UInt64 = 3
    static let opStartEeg: UInt64 = 0x0E
    static let opSync: UInt64 = 9

    /// Host identity the band has already accepted (from the reference capture).
    static let knownIdentity = "bcd1770495bd4674a578479480358e28"

    static let head: [UInt8] = [0x43, 0x4D, 0x53, 0x4E] // "CMSN"
    static let tail: [UInt8] = [0x50, 0x4B, 0x45, 0x44] // "PKED"

    static func varint(_ value: UInt64) -> [UInt8] {
        var out: [UInt8] = []
        var v = value
        while v > 0x7F {
            out.append(UInt8((v & 0x7F) | 0x80))
            v >>= 7
        }
        out.append(UInt8(v))
        return out
    }

    static func lenField(_ field: UInt64, _ body: [UInt8]) -> [UInt8] {
        [UInt8((field << 3) | 2)] + varint(UInt64(body.count)) + body
    }

    static func varintField(_ field: UInt64, _ value: UInt64) -> [UInt8] {
        [UInt8((field << 3) | 0)] + varint(value)
    }

    static func frame(_ payload: [UInt8]) -> Data {
        var out = head
        out.append(UInt8((payload.count >> 8) & 0xFF))
        out.append(UInt8(payload.count & 0xFF))
        out.append(contentsOf: payload)
        out.append(contentsOf: tail)
        return Data(out)
    }

    static func pairCommand(id: UInt64, identity: [UInt8]) -> Data {
        frame(varintField(1, id) + lenField(2, varintField(1, opPair) + lenField(6, identity)))
    }

    static func opCommand(id: UInt64, op: UInt64) -> Data {
        frame(varintField(1, id) + lenField(2, lenField(1, varint(op))))
    }

    static func syncCommand(id: UInt64, epochMs: UInt64) -> Data {
        frame(varintField(1, id) + lenField(2, lenField(1, varint(opSync) + varintField(2, epochMs))))
    }

    static func identityBytes(hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var chars = Array(hex.lowercased().filter { $0.isHexDigit })
        while out.count < 16 && chars.count >= 2 {
            let byte = String(chars.removeFirst()) + String(chars.removeFirst())
            out.append(UInt8(byte, radix: 16) ?? 0)
        }
        while out.count < 16 { out.append(0) }
        return out
    }
}

struct ProtoField {
    let field: UInt64
    let wire: UInt8
    let value: UInt64
    let bytes: [UInt8]?
}

func protoFields(_ bytes: [UInt8]) -> [ProtoField] {
    var out: [ProtoField] = []
    var at = 0
    func readVarint() -> UInt64? {
        var value: UInt64 = 0
        var shift: UInt64 = 0
        while at < bytes.count && shift <= 56 {
            let byte = bytes[at]
            at += 1
            value |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return value }
            shift += 7
        }
        return nil
    }
    while at < bytes.count {
        guard let key = readVarint() else { break }
        let field = key >> 3
        let wire = UInt8(key & 7)
        if field == 0 { break }
        if wire == 0 {
            guard let value = readVarint() else { break }
            out.append(ProtoField(field: field, wire: wire, value: value, bytes: nil))
        } else if wire == 2 {
            guard let length = readVarint(), at + Int(length) <= bytes.count else { break }
            let slice = Array(bytes[at ..< at + Int(length)])
            at += Int(length)
            out.append(ProtoField(field: field, wire: wire, value: length, bytes: slice))
        } else if wire == 1 || wire == 5 {
            let width = wire == 1 ? 8 : 4
            guard at + width <= bytes.count else { break }
            at += width
        } else { break }
    }
    return out
}

/// Reassembles CMSN frames across MTU-fragmented notifications.
final class Deframer {
    private var buffer: [UInt8] = []

    func reset() { buffer.removeAll(keepingCapacity: true) }

    func push(_ data: Data) -> [[UInt8]] {
        buffer.append(contentsOf: data)
        if buffer.count > 65_536 { buffer.removeFirst(buffer.count - 65_536) }
        var out: [[UInt8]] = []
        while true {
            guard let start = findHead() else {
                if buffer.count > 4 { buffer.removeFirst(buffer.count - 4) }
                break
            }
            if start > 0 { buffer.removeFirst(start) }
            if buffer.count < 6 { break }
            let length = Int(buffer[4]) << 8 | Int(buffer[5])
            if length > 8192 { buffer.removeFirst(1); continue }
            let total = 6 + length + 4
            if buffer.count < total { break }
            let tailOk = CMSN.tail.enumerated().allSatisfy { buffer[6 + length + $0.offset] == $0.element }
            if !tailOk { buffer.removeFirst(1); continue }
            out.append(Array(buffer[6 ..< 6 + length]))
            buffer.removeFirst(total)
        }
        return out
    }

    private func findHead() -> Int? {
        guard buffer.count >= 4 else { return nil }
        for i in 0 ... (buffer.count - 4) {
            if CMSN.head.enumerated().allSatisfy({ buffer[i + $0.offset] == $0.element }) { return i }
        }
        return nil
    }
}

func eegSamples(_ payload: [UInt8]) -> (seq: UInt64, counts: [Int32])? {
    guard let top = protoFields(payload).first(where: { $0.field == 2 && $0.bytes != nil }),
          let inner = top.bytes.map(protoFields),
          let data = inner.first(where: { $0.field == 4 && $0.bytes != nil })?.bytes,
          data.count >= 3, data.count % 3 == 0
    else { return nil }
    var counts: [Int32] = []
    counts.reserveCapacity(data.count / 3)
    var i = 0
    while i + 2 < data.count {
        let raw = Int32(data[i]) << 16 | Int32(data[i + 1]) << 8 | Int32(data[i + 2])
        counts.append(raw & 0x80_0000 != 0 ? raw - 0x100_0000 : raw)
        i += 3
    }
    let seq = inner.first(where: { $0.field == 1 && $0.wire == 0 })?.value ?? 0
    return (seq, counts)
}

func ackFields(_ payload: [UInt8]) -> (op: UInt64?, result: UInt64?)? {
    let fields = protoFields(payload)
    guard let ack = fields.first(where: { $0.field == 6 && $0.bytes != nil })?.bytes else { return nil }
    let inner = protoFields(ack)
    return (inner.first(where: { $0.field == 2 })?.value, inner.first(where: { $0.field == 3 })?.value)
}

// MARK: - WebSocket server

final class BridgeServer {
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let queue = DispatchQueue(label: "mindguard.bridge.ws")
    private var lastHello: Data?

    func start(port: UInt16) throws {
        let parameters = NWParameters.tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        parameters.allowLocalEndpointReuse = true

        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.queue.async {
                self.connections.append(connection)
                if let hello = self.lastHello { self.send(hello, to: connection) }
            }
            self.receive(connection)
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] _, _, isComplete, error in
            guard let self else { return }
            if error != nil || (isComplete && error != nil) {
                self.queue.async { self.connections.removeAll { $0 === connection } }
                return
            }
            self.receive(connection)
        }
    }

    /// Broadcasts one JSON object to every attached browser tab.
    func broadcast(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        if (object["type"] as? String) == "hello" { queue.async { self.lastHello = data } }
        queue.async {
            for connection in self.connections { self.send(data, to: connection) }
        }
    }

    private func send(_ data: Data, to connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "json", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}

// MARK: - CoreBluetooth central

final class HeadbandBridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private let server: BridgeServer
    private let nameFilter: String
    private let channel: String

    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private let deframer = Deframer()
    private var messageId: UInt64 = 0
    private var handshakeStep = 0
    private var acked = false
    private var skipPair: Bool
    private var firmware: String?
    private var helloSent = false
    private var lastDataAt = Date()
    private var watchdog: DispatchSourceTimer?

    init(server: BridgeServer, nameFilter: String, channel: String, skipPair: Bool) {
        self.server = server
        self.nameFilter = nameFilter.lowercased()
        self.channel = channel
        self.skipPair = skipPair
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
        startWatchdog()
    }

    private func log(_ level: String, _ message: String) {
        FileHandle.standardError.write("[\(level)] \(message)\n".data(using: .utf8)!)
        server.broadcast(["type": "log", "level": level, "message": message])
    }

    private func status(_ state: String, _ reason: String = "") {
        server.broadcast(["type": "status", "state": state, "reason": reason])
    }

    // Restarts the whole handshake when the band goes quiet: a silent link must
    // never be reported to the app as a healthy connection.
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self, let peripheral = self.peripheral else { return }
            if Date().timeIntervalSince(self.lastDataAt) > 12 {
                self.log("warn", "No EEG for 12 s — restarting the handshake.")
                self.status("reconnecting", "The headband stopped sending data.")
                self.central.cancelPeripheralConnection(peripheral)
            }
        }
        timer.resume()
        watchdog = timer
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            status("scanning", "Looking for the headband…")
            log("info", "Scanning for a headband matching “\(nameFilter)”.")
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        case .unauthorized:
            log("error", "Bluetooth permission denied. Grant it in System Settings → Privacy & Security → Bluetooth.")
        case .poweredOff:
            log("error", "Bluetooth is off.")
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = (peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "").lowercased()
        guard !name.isEmpty, name.contains(nameFilter) else { return }
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        log("info", "Found “\(peripheral.name ?? name)” (RSSI \(RSSI)). Connecting…")
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        // CoreBluetooth negotiates the encrypted/bonded link for us as soon as
        // an encrypted characteristic is touched — this is the step the browser
        // cannot perform.
        deframer.reset()
        messageId = 0
        handshakeStep = 0
        acked = false
        lastDataAt = Date()
        log("info", "Connected. Discovering services…")
        peripheral.discoverServices([CMSN.service, CMSN.deviceInfo, CMSN.batteryService])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log("error", "Connect failed: \(error?.localizedDescription ?? "unknown"). Rescanning.")
        status("reconnecting", "Connect failed.")
        central.scanForPeripherals(withServices: nil, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        log("warn", "Link lost: \(error?.localizedDescription ?? "clean disconnect").")
        status("lost", "The headband disconnected.")
        writeChar = nil
        // Alternate the pair/skip-pair path so a stale bond cannot wedge us.
        skipPair.toggle()
        central.connect(peripheral, options: nil)
    }

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
        handshakeStep += 1
        switch handshakeStep {
        case 1:
            if skipPair {
                log("info", "Skipping pair — the band is already bonded to this Mac.")
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
            status("connected", "")
        default:
            break
        }
    }

    private func schedule(after seconds: Double = 0.35) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.advanceHandshake() }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let value = characteristic.value else { return }
        switch characteristic.uuid {
        case CMSN.firmwareRevision:
            firmware = String(data: value, encoding: .utf8)
            log("info", "Firmware \(firmware ?? "unknown").")
        case CMSN.batteryLevel:
            if let percent = value.first {
                server.broadcast(["type": "battery", "percent": Int(percent)])
            }
        case CMSN.notify:
            handleNotification(value)
        default:
            break
        }
    }

    private func handleNotification(_ data: Data) {
        for payload in deframer.push(data) {
            if let eeg = eegSamples(payload) {
                lastDataAt = Date()
                sendHelloIfNeeded()
                let microvolts = eeg.counts.map { Double($0) * CMSN.uvPerCount }
                server.broadcast([
                    "type": "samples",
                    "seq": Int(eeg.seq),
                    "channels": [channel: microvolts],
                ])
            } else if let ack = ackFields(payload) {
                acked = true
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
        status("connected", "")
        log("info", "EEG streaming — decoded samples are on the WebSocket.")
    }
}

// MARK: - Entry point

var port: UInt16 = 8787
var nameFilter = "regul8"
var channel = "AF7"
var skipPair = true

var args = Array(CommandLine.arguments.dropFirst())
while let flag = args.first {
    args.removeFirst()
    switch flag {
    case "--port": port = UInt16(args.first ?? "") ?? port; if !args.isEmpty { args.removeFirst() }
    case "--name": nameFilter = args.first ?? nameFilter; if !args.isEmpty { args.removeFirst() }
    case "--channel": channel = args.first ?? channel; if !args.isEmpty { args.removeFirst() }
    case "--pair": skipPair = false
    case "--help":
        print("""
        MindGuard macOS headband bridge

          --port <n>       WebSocket port (default 8787)
          --name <text>    Substring of the advertised name (default "regul8")
          --channel <id>   Analysis electrode the single channel maps to (default AF7)
          --pair           Send the CMSN pair command first (default: skip, band is bonded)
        """)
        exit(0)
    default:
        break
    }
}

let server = BridgeServer()
do {
    try server.start(port: port)
} catch {
    FileHandle.standardError.write("Could not listen on port \(port): \(error)\n".data(using: .utf8)!)
    exit(1)
}
print("MindGuard bridge listening on ws://127.0.0.1:\(port) — open the app and connect to it.")
_ = HeadbandBridge(server: server, nameFilter: nameFilter, channel: channel, skipPair: skipPair)
RunLoop.main.run()
