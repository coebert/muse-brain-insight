// CMSN protocol core, shared with bridge/macos/MindGuardBridge.swift and
// src/lib/eeg/focuscalm-cmsn.ts. Everything here was derived from the
// PacketLogger capture of the official FocusCalm app talking to the FC-11
// (Regul8) headband, so keep the three implementations in step.

import CoreBluetooth
import Foundation

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
