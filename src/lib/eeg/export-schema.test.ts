import { describe, expect, it } from "vitest";

import {
  anonymisationTag,
  buildExportMeta,
  exportMetaSchema,
  validateDiagnosticExport,
} from "@/lib/eeg/export-schema";

const packetEntry = (index: number) => ({
  t: index * 80,
  at: 1_000 + index * 80,
  kind: "packet" as const,
  message: "service/notify — notification",
  rawHex: Array.from({ length: 20 }, (_, i) => ((i * 7) % 256).toString(16).padStart(2, "0")).join(" "),
  bytes: 20,
});

describe("export metadata", () => {
  it("embeds time, device, firmware, sample rate and an anonymisation tag", () => {
    const meta = buildExportMeta({
      kind: "debug-session",
      deviceLabel: "Regul8",
      deviceInfo: { firmwareVersion: "1.4.2", model: "REG8" },
      sampleRate: 256,
      startedAt: 1_700_000_000_000,
    });
    expect(exportMetaSchema.parse(meta)).toBeTruthy();
    expect(meta.device.firmwareVersion).toBe("1.4.2");
    expect(meta.sampleRateHz).toBe(256);
    expect(meta.sessionStartedAt).toBe(1_700_000_000_000);
    expect(meta.anonymisation.tag).toMatch(/^ANON-[0-9A-Z]{8}$/);
    expect(meta.anonymisation.containsPatientData).toBe(false);
  });

  it("produces stable tags for one session and different tags across sessions", () => {
    const a = anonymisationTag("Regul8||1_700_000_000_000");
    expect(anonymisationTag("Regul8||1_700_000_000_000")).toBe(a);
    expect(anonymisationTag("Regul8||1_700_100_000_000")).not.toBe(a);
  });
});

describe("diagnostic export validation", () => {
  const validLog = JSON.stringify({
    meta: buildExportMeta({ kind: "ble-log", deviceLabel: "Regul8", sampleRate: 256 }),
    packetTotals: { "svc/char": 4 },
    entries: Array.from({ length: 4 }, (_, i) => packetEntry(i)),
  });

  it("marks a complete capture as decoder-ready", () => {
    const check = validateDiagnosticExport(validLog);
    expect(check.level).toBe("ready");
    expect(check.replayablePackets).toBe(4);
    expect(check.meta?.anonymisation.tag).toMatch(/^ANON-/);
    expect(check.issues).toHaveLength(0);
  });

  it("flags truncated packets as not decoder-ready", () => {
    const broken = JSON.parse(validLog);
    for (const entry of broken.entries) entry.rawHex = "55 aa … (+240 bytes)";
    const check = validateDiagnosticExport(JSON.stringify(broken));
    expect(check.level).toBe("invalid");
    expect(check.truncatedPackets).toBe(4);
  });

  it("flags old captures without metadata as partial, not invalid", () => {
    const legacy = JSON.stringify({ entries: Array.from({ length: 6 }, (_, i) => packetEntry(i)) });
    const check = validateDiagnosticExport(legacy);
    expect(check.level).toBe("partial");
    expect(check.issues.some((issue) => /metadata/i.test(issue))).toBe(true);
  });

  it("rejects malformed JSON and wrong shapes immediately", () => {
    expect(validateDiagnosticExport("{not json").level).toBe("invalid");
    const wrong = validateDiagnosticExport(JSON.stringify({ entries: [{ kind: "nonsense" }] }));
    expect(wrong.level).toBe("invalid");
    expect(wrong.issues.join(" ")).toContain("kind");
  });

  it("validates debug-session exports too", () => {
    const session = JSON.stringify({
      meta: buildExportMeta({ kind: "debug-session", deviceLabel: "Muse 2" }),
      frames: [],
      connectionLog: Array.from({ length: 5 }, (_, i) => packetEntry(i)),
    });
    const check = validateDiagnosticExport(session);
    expect(check.kind).toBe("debug-session");
    expect(check.level).toBe("ready");
  });
});

// Zod 4 requires an explicit key schema on z.record(); these synthetic captures
// pin the record-shaped fields (entry data, packet totals, session frames) so a
// validator upgrade cannot silently start accepting or rejecting them.
describe("diagnostic export record fields (Zod 4 compatibility)", () => {
  const meta = buildExportMeta({ kind: "ble-log", deviceLabel: "Muse 2", sampleRate: 256 });

  it("accepts free-form entry data and numeric packet totals", () => {
    const check = validateDiagnosticExport(
      JSON.stringify({
        meta,
        packetTotals: { "fe8d/273e0003": 3, "fe8d/273e0004": 1 },
        entries: [
          { t: 0, at: 1_000, kind: "info", message: "start", data: { variant: "p21", retries: 2, nested: { ok: true } } },
          ...Array.from({ length: 4 }, (_, i) => packetEntry(i + 1)),
        ],
      }),
    );
    expect(check.level).toBe("ready");
    expect(check.replayablePackets).toBe(4);
  });

  it("rejects non-numeric packet totals and names the field", () => {
    const check = validateDiagnosticExport(
      JSON.stringify({ meta, packetTotals: { "fe8d/273e0003": "three" }, entries: [packetEntry(0)] }),
    );
    expect(check.level).toBe("invalid");
    expect(check.issues.join(" ")).toContain("packetTotals.fe8d/273e0003");
  });

  it("rejects entry data that is not an object", () => {
    const check = validateDiagnosticExport(
      JSON.stringify({ meta, entries: [{ t: 0, at: 1, kind: "info", message: "x", data: [1, 2] }] }),
    );
    expect(check.level).toBe("invalid");
    expect(check.issues.join(" ")).toContain("entries.0.data");
  });

  it("reports received-but-unstored notifications from packet totals", () => {
    const check = validateDiagnosticExport(
      JSON.stringify({ meta, packetTotals: { a: 5, b: 2 }, entries: [{ t: 0, at: 1, kind: "info", message: "x" }] }),
    );
    expect(check.issues.some((issue) => issue.startsWith("7 notification(s)"))).toBe(true);
  });

  it("accepts session frames as keyed records and rejects non-object frames", () => {
    const base = {
      meta: buildExportMeta({ kind: "debug-session", deviceLabel: "Muse 2" }),
      connectionLog: Array.from({ length: 5 }, (_, i) => packetEntry(i)),
    };
    const ok = validateDiagnosticExport(
      JSON.stringify({ ...base, frames: [{ t: 0, tp9: 1.5, af7: null }, { t: 1, quality: "good" }] }),
    );
    expect(ok.kind).toBe("debug-session");
    expect(ok.level).toBe("ready");
    const bad = validateDiagnosticExport(JSON.stringify({ ...base, frames: [42] }));
    expect(bad.level).toBe("invalid");
    expect(bad.issues.join(" ")).toContain("frames.0");
  });
});
