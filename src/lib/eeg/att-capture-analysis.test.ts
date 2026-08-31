import { describe, expect, it } from "vitest";

import { analyseAttCapture, sanitisedAttAnalysisJson } from "@/lib/eeg/att-capture-analysis";
import { zenliteAfeCommand, zenliteSysCommand, ZENLITE_AFE, ZENLITE_CMD } from "@/lib/eeg/brainco-zenlite";

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");

describe("FC-11 ATT capture analysis", () => {
  it("imports Wireshark JSON, validates BRNC and correlates writes with replies", () => {
    const write = zenliteAfeCommand(3, ZENLITE_AFE.sr256);
    const notify = zenliteSysCommand(4, ZENLITE_CMD.startDataStream);
    const capture = [
      { _source: { layers: { frame: { "frame.time_epoch": "1000.000" }, btatt: { "btatt.opcode": "0x12", "btatt.handle": "0x0012", "btatt.value": hex(write), "btatt.uuid128": "0d740002-d26f-4dbb-95e8-a4f5c55c57a9" }, bluetooth: { "bluetooth.src": "AA:BB:CC:DD:EE:FF" } } } },
      { _source: { layers: { frame: { "frame.time_epoch": "1000.125" }, btatt: { "btatt.opcode": "0x1b", "btatt.handle": "0x0015", "btatt.value": hex(notify), "btatt.uuid128": "0d740003-d26f-4dbb-95e8-a4f5c55c57a9" } } } },
    ];
    const result = analyseAttCapture(JSON.stringify(capture));
    expect(result.format).toBe("wireshark-json");
    expect(result.writes).toBe(1);
    expect(result.notifications).toBe(1);
    expect(result.validCrcFrames).toBe(2);
    expect(result.correlations[0]?.firstReplyMs).toBe(125);
    expect(result.protobufFields.some((field) => field.path === "1" && field.wireType === 0)).toBe(true);
    const exported = sanitisedAttAnalysisJson(result);
    expect(exported).not.toContain("AA:BB:CC:DD:EE:FF");
    expect(exported).toContain("fc11-att-analysis");
  });

  it("imports a simple CSV transcript", () => {
    const command = hex(zenliteSysCommand(1, ZENLITE_CMD.startDataStream));
    const result = analyseAttCapture(`time,direction,characteristic,value\n0,write,0d740002-d26f-4dbb-95e8-a4f5c55c57a9,${command}`);
    expect(result.format).toBe("csv");
    expect(result.events).toHaveLength(1);
    expect(result.warnings).toContain("No notifications were found; the capture cannot show what made streaming begin.");
  });

  it("rejects exports without ATT payloads", () => {
    expect(() => analyseAttCapture(JSON.stringify([{ frame: 1 }]))).toThrow(/No ATT writes/);
  });
});