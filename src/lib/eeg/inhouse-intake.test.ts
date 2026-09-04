import { describe, expect, it } from "vitest";

import {
  buildInhousePairedRow,
  nearestEpoch,
  parseInhouseAnnotation,
  planInhouseIntake,
} from "./inhouse-intake";

const ev = (id: string, at: number, detail: string) => ({
  id,
  session_id: "s1",
  t_offset_seconds: at,
  detail,
});

describe("in-house annotation intake", () => {
  it("reads monitor and app values from a full annotation", () => {
    const r = parseInhouseAnnotation(
      ev("a", 291, "BIS reference — BIS VISTA: BIS 46, SR 0 %, SEF 16 Hz (app 92)"),
    );
    expect(r).toMatchObject({ bis: 46, bisSr: 0, bisSef: 16, appIndex: 92, device: "BIS VISTA" });
  });

  it("reads a reading with only a suppression ratio", () => {
    const r = parseInhouseAnnotation(ev("b", 10, "BIS reference — BIS VISTA: BIS 32, SR 24 % (app 76)"));
    expect(r).toMatchObject({ bis: 32, bisSr: 24, bisSef: null, appIndex: 76 });
  });

  it("refuses an annotation with no app index", () => {
    expect(
      parseInhouseAnnotation(ev("c", 183, "BIS reference — BIS VISTA: BIS 43, SR 0 %, SEF 16 Hz")),
    ).toBeNull();
  });

  it("ignores unrelated timeline entries", () => {
    expect(parseInhouseAnnotation(ev("d", 5, "TCI start — Eleveld propofol"))).toBeNull();
  });

  it("rejects out-of-range monitor values", () => {
    expect(parseInhouseAnnotation(ev("e", 5, "BIS reference — X: BIS 140 (app 50)"))).toBeNull();
  });

  it("attaches a nearby epoch and drops a distant one", () => {
    const reading = parseInhouseAnnotation(ev("f", 100, "BIS reference — X: BIS 40 (app 60)"))!;
    const epochs = [
      { sessionId: "s1", at: 96, appIndex: 60, appSr: 2, appSef: 14 },
      { sessionId: "s1", at: 400, appIndex: 55, appSr: 0, appSef: 18 },
    ];
    expect(nearestEpoch(reading, epochs)?.at).toBe(96);
    expect(nearestEpoch({ ...reading, at: 900 }, epochs)).toBeNull();
  });

  it("marks an annotation-only reading with lower confidence", () => {
    const reading = parseInhouseAnnotation(ev("g", 2226, "BIS reference — X: BIS 40, SR 3 % (app 76)"))!;
    const row = buildInhousePairedRow(reading, null, {
      userId: "u",
      lineage: "muse-2|TP9-AF7-AF8-TP10|256",
      context: "general_anaesthesia",
    });
    expect(row).toMatchObject({
      feature_source: "annotation",
      app_sr: null,
      depth_confidence: 0.7,
      reliable: true,
      external_ref: "inhouse-annotation:g",
    });
  });

  it("marks a reading taken during a quality warning as unreliable", () => {
    const reading = parseInhouseAnnotation(ev("h", 10, "BIS reference — X: BIS 40 (app 60)"))!;
    const row = buildInhousePairedRow(reading, null, {
      userId: "u",
      lineage: "l",
      context: "general_anaesthesia",
      qualityWarning: true,
    });
    expect(row.reliable).toBe(false);
  });

  it("skips annotations already filed as paired readings", () => {
    const events = [
      ev("a", 10, "BIS reference — X: BIS 40 (app 60)"),
      ev("b", 20, "BIS reference — X: BIS 41 (app 61)"),
      ev("c", 30, "BIS reference — X: BIS 42"),
      ev("d", 40, "Audit — alarms acknowledged"),
    ];
    const { readings, survey } = planInhouseIntake(
      events,
      new Set(["inhouse-annotation:a"]),
      (s, at) => s === "s1" && at === 20,
    );
    expect(readings).toHaveLength(0);
    expect(survey).toMatchObject({ parsed: 2, unpairable: 1, alreadyPaired: 2, recovered: 0 });
  });
});
