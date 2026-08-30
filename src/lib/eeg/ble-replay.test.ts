import { describe, expect, it } from "vitest";

import { replayBleDiagnostic } from "@/lib/eeg/ble-replay";

function int16Packets(): Array<{ kind: string; message: string; at: number; rawHex: string }> {
  const values = Array.from({ length: 320 }, (_, i) => Math.round(800 * Math.sin((2 * Math.PI * i) / 40)));
  return Array.from({ length: 16 }, (_, packet) => {
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 20; i++) view.setInt16(i * 2, values[packet * 20 + i] ?? 0, true);
    return {
      kind: "packet",
      message: "service/notify — discovery notification",
      at: 1_000 + packet * 80,
      rawHex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" "),
    };
  });
}

describe("BLE packet replay", () => {
  it("imports a diagnostic export and reruns format detection", () => {
    const result = replayBleDiagnostic(JSON.stringify({ entries: int16Packets() }));
    expect(result.packetCount).toBe(16);
    expect(result.format).toBe("int16le");
    expect(result.decodedSamples).toBe(320);
    expect(result.sourceCount).toBe(1);
  });

  it("rejects logs without complete raw notifications", () => {
    // An empty log is now reported as a silent band rather than as missing
    // raw bytes, because the two failures need different fixes.
    expect(() => replayBleDiagnostic(JSON.stringify({ entries: [] }))).toThrow(
      /never sent|no complete raw/i,
    );
  });
});