import { describe, expect, it } from "vitest";

import {
  REFERENCE_FORMATS,
  detectFormat,
  formatById,
  normaliseState,
  parseReferenceFile,
  stateFromMoaas,
} from "../reference-library";

describe("reference library catalogue", () => {
  it("gives every format a required time column first", () => {
    for (const f of REFERENCE_FORMATS) {
      expect(f.columns[0]?.required).toBe(true);
      expect(f.columns.some((c) => c.required)).toBe(true);
      expect(f.sample.split("\n").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("has unique ids", () => {
    const ids = REFERENCE_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("detectFormat", () => {
  it("recognises a monitor export with suppression and quality", () => {
    expect(detectFormat("time,bis,sr,sef,sqi")?.kind).toBe("bis-monitor");
  });

  it("recognises a MOAA/S sheet", () => {
    expect(detectFormat("time,moaas,note")?.kind).toBe("sedation-scale");
  });

  it("recognises a tab separated event file", () => {
    expect(detectFormat("onset\tduration\ttrial_type")?.kind).toBe("event-file");
  });

  it("returns nothing when no required column is present", () => {
    expect(detectFormat("patient,notes")).toBeNull();
  });
});

describe("state vocabulary", () => {
  it("maps MOAA/S onto the shared words", () => {
    expect(stateFromMoaas(5)).toBe("awake");
    expect(stateFromMoaas(3)).toBe("sedated");
    expect(stateFromMoaas(1)).toBe("anaesthetised");
  });

  it("accepts loss and return of consciousness markers", () => {
    expect(normaliseState("LOC")).toBe("induction");
    expect(normaliseState("return of consciousness")).toBe("awake");
    expect(normaliseState("maintenance")).toBe("anaesthetised");
    expect(normaliseState("banana")).toBeNull();
  });
});

describe("parseReferenceFile", () => {
  const bis = formatById("generic-bis")!;

  it("reads a monitor export", () => {
    const parsed = parseReferenceFile(bis, "time,bis,sr,sef\n0,97,0,22\n600,38,4,10.8");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1]).toMatchObject({ at: 600, bis: 38, sr: 4, sef: 10.8 });
    expect(parsed.missingColumns).toEqual([]);
  });

  it("reports rather than repairs impossible values", () => {
    const parsed = parseReferenceFile(bis, "time,bis\n0,97\n10,140\nx,50");
    expect(parsed.rows).toHaveLength(1);
    const reasons = parsed.skipped.map((s) => s.reason);
    expect(reasons).toContain("index outside 0–100");
    expect(reasons).toContain("no readable time");
  });

  it("names missing required columns", () => {
    const parsed = parseReferenceFile(bis, "time,heart_rate\n0,60");
    expect(parsed.missingColumns).toEqual(["bis"]);
    expect(parsed.rows).toEqual([]);
  });

  it("lists columns it does not use", () => {
    const parsed = parseReferenceFile(bis, "time,bis,surgeon\n0,50,ab");
    expect(parsed.unusedColumns).toEqual(["surgeon"]);
  });

  it("turns MOAA/S scores into states", () => {
    const parsed = parseReferenceFile(formatById("generic-moaas")!, "time,moaas\n0,5\n300,2");
    expect(parsed.rows.map((r) => r.state)).toEqual(["awake", "anaesthetised"]);
  });

  it("rebases a clock-stamped sedation file to seconds from the start", () => {
    const parsed = parseReferenceFile(
      formatById("dose1-moaas")!,
      "time,moaas\n2026-03-02T09:00:00Z,5\n2026-03-02T09:05:00Z,2",
    );
    expect(parsed.rows.map((r) => r.at)).toEqual([0, 300]);
  });

  it("reads a tab separated event file and flags unknown markers", () => {
    const parsed = parseReferenceFile(
      formatById("bids-events")!,
      "onset\tduration\ttrial_type\n10\t60\tawake\n80\t20\tsomething",
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ at: 10, duration: 60, state: "awake" });
    expect(parsed.skipped[0]?.reason).toContain("unrecognised marker");
  });

  it("returns missing columns for an empty file", () => {
    const parsed = parseReferenceFile(bis, "");
    expect(parsed.rows).toEqual([]);
    expect(parsed.missingColumns.length).toBeGreaterThan(0);
  });
});
