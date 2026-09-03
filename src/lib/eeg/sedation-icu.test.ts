import { describe, expect, it } from "vitest";

import {
  DEFAULT_SAMPLE_RATE,
  DOSE1_LINEAGE,
  ICARE_LINEAGE,
  epochsFromRecording,
  parseSedationIcuCsv,
  sedationIcuLineage,
  toSedationIcuRows,
} from "./sedation-icu";

/** Sine EEG with an optional suppressed (flat) second half. */
function csv(opts: { rate: number; seconds: number; label?: string; flatFrom?: number }) {
  const rows = ["time,fp1_f7,fp2_f8" + (opts.label ? ",label" : "")];
  const n = Math.round(opts.rate * opts.seconds);
  for (let i = 0; i < n; i++) {
    const t = i / opts.rate;
    const flat = opts.flatFrom != null && t >= opts.flatFrom;
    const v = flat ? 0.4 * Math.sin(2 * Math.PI * 10 * t) : 40 * Math.sin(2 * Math.PI * 10 * t);
    rows.push(
      `${t.toFixed(4)},${v.toFixed(3)},${(v * 0.9).toFixed(3)}` +
        (opts.label ? `,${flat ? "burst suppression" : opts.label}` : ""),
    );
  }
  return rows.join("\n");
}

describe("sedation/ICU ingest", () => {
  it("parses channels and recovers the sample rate from the clock", () => {
    const rec = parseSedationIcuCsv(csv({ rate: 125, seconds: 20 }), DEFAULT_SAMPLE_RATE.dose1);
    expect(rec.channels).toEqual(["FP1_F7", "FP2_F8"]);
    expect(rec.sampleRate).toBeCloseTo(125, 0);
    expect(rec.labels).toBeNull();
    expect(rec.signals[0]!.length).toBe(2500);
  });

  it("never treats an annotation column as a dead channel", () => {
    const rec = parseSedationIcuCsv(
      csv({ rate: 125, seconds: 12, label: "sedated" }),
      DEFAULT_SAMPLE_RATE.dose1,
    );
    expect(rec.channels).toEqual(["FP1_F7", "FP2_F8"]);
    expect(rec.labels?.[0]).toBe("sedated");
  });

  it("derives suppression and keeps published labels as dataset ground truth", () => {
    const rec = parseSedationIcuCsv(
      csv({ rate: 125, seconds: 40, label: "sedated", flatFrom: 20 }),
      DEFAULT_SAMPLE_RATE.dose1,
    );
    const epochs = epochsFromRecording(rec, 0, {
      dataset: "dose1",
      caseRef: "dose_01",
      channel: "FP1-F7",
    });
    expect(epochs.length).toBeGreaterThan(5);
    expect(epochs.every((e) => e.labelSource === "dataset")).toBe(true);
    expect(epochs[0]!.label).toBe("sedated");
    expect(epochs.at(-1)!.label).toBe("burst_suppression");
    expect(epochs.at(-1)!.isSuppressed).toBe(true);
    expect(epochs[0]!.isSuppressed).toBe(false);
  });

  it("marks verdicts derived when the export carries no labels", () => {
    const rec = parseSedationIcuCsv(csv({ rate: 100, seconds: 20 }), DEFAULT_SAMPLE_RATE.icare);
    const epochs = epochsFromRecording(rec, 0, {
      dataset: "icare",
      caseRef: "icare_0284",
      channel: "FP1",
    });
    expect(epochs.every((e) => e.labelSource === "derived")).toBe(true);
  });

  it("gives each collection its own lineage and deterministic references", () => {
    expect(sedationIcuLineage("dose1").lineage).toBe(DOSE1_LINEAGE);
    expect(sedationIcuLineage("icare").lineage).toBe(ICARE_LINEAGE);

    const rec = parseSedationIcuCsv(csv({ rate: 125, seconds: 12 }), 125);
    const a = epochsFromRecording(rec, 0, { dataset: "dose1", caseRef: "c1", channel: "FP1-F7" });
    const b = epochsFromRecording(rec, 0, { dataset: "dose1", caseRef: "c1", channel: "FP1-F7" });
    expect(a.map((e) => e.externalRef)).toEqual(b.map((e) => e.externalRef));
    expect(a[0]!.externalRef.startsWith("zenodo-dose-i:c1:FP1-F7:")).toBe(true);

    const rows = toSedationIcuRows("icare", a, { covariates: { age_band: "60-69" } });
    expect(rows[0]!.sourceLineage).toBe(ICARE_LINEAGE);
    expect(rows[0]!.covariates["age_band"]).toBe("60-69");
  });
});
