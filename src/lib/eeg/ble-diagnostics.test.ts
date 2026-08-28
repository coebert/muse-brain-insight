import { describe, expect, it, beforeEach } from "vitest";

import {
  BleDiagnosticLog,
  BlePacketInspector,
  bleDiagnosticJson,
  formatBleDiagnosticText,
  packetsToCsv,
  toHex,
} from "@/lib/eeg/ble-diagnostics";

describe("BLE diagnostic logger", () => {
  let log: BleDiagnosticLog;

  beforeEach(() => {
    log = new BleDiagnosticLog();
  });

  it("keeps lifecycle evidence but gates raw bytes until enabled", () => {
    log.add("gatt", "connect");
    log.packet("svc/char", Uint8Array.from([1, 2]));
    expect(log.all().map((entry) => entry.message)).toEqual(["connect"]);
    expect(log.packetTotals()["svc/char"]).toBe(1);
    log.setEnabled(true);
    log.add("gatt", "connect");
    expect(log.all().some((e) => e.message === "connect")).toBe(true);
  });

  it("records discovery, commands and raw bytes", () => {
    log.setEnabled(true);
    log.beginSession("Regul8");
    log.add("service", "2 services", { services: ["a", "b"] });
    log.add("command", "pair", { mode: "write" }, Uint8Array.from([0x42, 0x52, 0x4e, 0x43]));
    const entries = log.all();
    expect(entries[0]?.kind).toBe("session");
    expect(entries.find((e) => e.kind === "service")?.data?.["services"]).toEqual(["a", "b"]);
    const command = entries.find((e) => e.kind === "command");
    expect(command?.hex).toBe("42 52 4e 43");
    expect(command?.bytes).toBe(4);
  });

  it("rate-limits raw packets per characteristic but keeps totals", () => {
    log.setEnabled(true);
    log.beginSession("band");
    for (let i = 0; i < 40; i++) log.packet("svc/char", Uint8Array.from([i]));
    const packets = log.all().filter((e) => e.kind === "packet");
    expect(packets.length).toBeLessThanOrEqual(12);
    expect(log.packetTotals()["svc/char"]).toBe(40);
  });

  it("truncates long frames in the hex dump", () => {
    const hex = toHex(new Uint8Array(100), 8);
    expect(hex.endsWith("(+92 bytes)")).toBe(true);
  });

  it("exports text and JSON", () => {
    log.setEnabled(true);
    log.add("error", "boom", { code: 1 });
    const text = formatBleDiagnosticText(log.all(), { "svc/char": 7 });
    expect(text).toContain("ERROR");
    expect(text).toContain("svc/char: 7");
    const json = JSON.parse(bleDiagnosticJson(log.all(), { "svc/char": 7 }));
    expect(json.entries.some((e: { message: string }) => e.message === "boom")).toBe(true);
    expect(json.packetTotals["svc/char"]).toBe(7);
  });
});

describe("packet inspector", () => {
  it("timestamps notifications with inter-packet delta and exports CSV", () => {
    const inspector = new BlePacketInspector();
    inspector.setEnabled(true);
    inspector.record({
      at: 1_000,
      source: "svc/char",
      format: "int16le",
      bytes: Uint8Array.from([1, 2]),
      decodedSamples: 1,
      amplitudeUv: 12.34,
    });
    inspector.record({
      at: 1_040,
      source: "svc/char",
      format: "int16le",
      bytes: Uint8Array.from([3, 4]),
      decodedSamples: 1,
      amplitudeUv: 10,
    });
    const rows = inspector.all();
    expect(rows[0]?.deltaMs).toBe(0);
    expect(rows[1]?.deltaMs).toBe(40);
    const csv = packetsToCsv(rows);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain("01 02");
  });

  it("stays inert while disabled", () => {
    const inspector = new BlePacketInspector();
    inspector.record({
      at: 1,
      source: "s",
      format: "int16le",
      bytes: new Uint8Array(2),
      decodedSamples: 0,
      amplitudeUv: 0,
    });
    expect(inspector.all()).toHaveLength(0);
  });
});
