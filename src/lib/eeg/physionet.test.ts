import { describe, expect, it } from "vitest";

import {
  deriveEpochsFromRaw,
  lineageFor,
  normalisePhysionetLabel,
  parsePhysionetPowerCsv,
  parsePhysionetRawCsv,
  summarisePhysionet,
  toImportRows,
  PHYSIONET_GABA_LINEAGE,
  PHYSIONET_POWER_LINEAGE,
} from "./physionet";

const FS = 250;

function rawCsv(seconds: number, amplitude: (t: number) => number): string {
  const lines = ["time,af7"];
  for (let i = 0; i < seconds * FS; i++) {
    const t = i / FS;
    lines.push(`${t.toFixed(4)},${amplitude(t).toFixed(4)}`);
  }
  return lines.join("\n");
}

describe("physionet raw ingest", () => {
  it("reads the sampling rate and channel names", () => {
    const rec = parsePhysionetRawCsv(rawCsv(2, (t) => 20 * Math.sin(2 * Math.PI * 10 * t)));
    expect(rec.channels).toEqual(["AF7"]);
    expect(rec.sampleRate).toBeCloseTo(FS, 0);
    expect(rec.signals[0]!.length).toBe(2 * FS);
  });

  it("derives DSA features and flags burst suppression", () => {
    // 8 s of 10 Hz alpha, then 8 s of near-flat trace.
    const rec = parsePhysionetRawCsv(
      rawCsv(16, (t) => (t < 8 ? 30 * Math.sin(2 * Math.PI * 10 * t) : 0.5 * Math.sin(t))),
    );
    const epochs = deriveEpochsFromRaw(rec.signals[0]!, rec.sampleRate, { caseRef: "case01" });
    expect(epochs.length).toBeGreaterThan(2);
    expect(epochs[0]!.spectrumDb.length).toBe(60);
    expect(epochs[0]!.isSuppressed).toBe(false);
    expect(epochs[0]!.bands.alpha).toBeGreaterThan(epochs[0]!.bands.gamma);

    const last = epochs[epochs.length - 1]!;
    expect(last.isSuppressed).toBe(true);
    expect(last.label).toBe("burst_suppression");
    expect(last.labelSource).toBe("derived");
    expect(last.suppressionRatio).toBeGreaterThan(0);
  });

  it("produces deterministic external references", () => {
    const rec = parsePhysionetRawCsv(rawCsv(8, () => 0));
    const a = deriveEpochsFromRaw(rec.signals[0]!, rec.sampleRate, { caseRef: "c1" });
    const b = deriveEpochsFromRaw(rec.signals[0]!, rec.sampleRate, { caseRef: "c1" });
    expect(a.map((e) => e.externalRef)).toEqual(b.map((e) => e.externalRef));
    expect(new Set(a.map((e) => e.externalRef)).size).toBe(a.length);
  });
});

describe("physionet power ingest", () => {
  const csv = [
    "time,state,1,2,4,8,10,16,24,30",
    "0,Awake,1,1,2,4,8,4,2,1",
    "4,burst suppression,20,18,6,1,0.5,0.2,0.1,0.1",
  ].join("\n");

  it("maps published spectra and labels onto the DSA grid", () => {
    const rows = parsePhysionetPowerCsv(csv, { caseRef: "p1" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.spectrumDb.length).toBe(60);
    expect(rows[0]!.label).toBe("awake");
    expect(rows[0]!.labelSource).toBe("dataset");
    expect(rows[0]!.isSuppressed).toBe(false);
    expect(rows[1]!.label).toBe("burst_suppression");
    expect(rows[1]!.isSuppressed).toBe(true);
    expect(rows[1]!.bands.delta).toBeGreaterThan(rows[0]!.bands.delta);
    expect(rows[1]!.sef95).toBeLessThan(rows[0]!.sef95);
    expect(rows[1]!.atSeconds).toBe(4);
  });

  it("normalises label spellings", () => {
    expect(normalisePhysionetLabel("Burst-Suppression")).toBe("burst_suppression");
    expect(normalisePhysionetLabel("BS")).toBe("burst_suppression");
    expect(normalisePhysionetLabel("unconscious")).toBe("anaesthetised");
    expect(normalisePhysionetLabel("")).toBeNull();
  });
});

describe("lineage tagging", () => {
  it("keeps each collection under its own lineage", () => {
    expect(lineageFor("gaba").lineage).toBe(PHYSIONET_GABA_LINEAGE);
    expect(lineageFor("power").lineage).toBe(PHYSIONET_POWER_LINEAGE);

    const rows = parsePhysionetPowerCsv(
      ["time,1,2,4,8", "0,1,1,1,1"].join("\n"),
      { caseRef: "p2" },
    );
    const tagged = toImportRows("power", rows, { datasetVersion: "1.0.0" });
    expect(tagged[0]!.sourceLineage).toBe(PHYSIONET_POWER_LINEAGE);
    expect(tagged[0]!.datasetVersion).toBe("1.0.0");

    const summary = summarisePhysionet(rows);
    expect(summary.cases).toBe(1);
    expect(summary.epochs).toBe(1);
  });
});
