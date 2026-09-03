import { describe, expect, it } from "vitest";

import {
  buildProvenance,
  caseRefFromPath,
  checkEligibility,
  findSource,
  INTAKE_SOURCES,
  INTAKE_VERSION,
  parseRecordsIndex,
  parseZenodoIndex,
  planIntake,
} from "./dataset-intake";

const open = { ...findSource("zenodo-dose-i")!, filePattern: /\.csv$/i };
const restricted = findSource("physionet-i-care")!;

describe("licence gating", () => {
  it("only allows automated fetch for openly licensed sources", () => {
    expect(checkEligibility(open).eligible).toBe(true);
    const gate = checkEligibility(restricted);
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/credentials are not configured/i);
  });

  it("unlocks a credentialed source once its realm login is stored", () => {
    const gate = checkEligibility(restricted, ["physionet"]);
    expect(gate.eligible).toBe(true);
    expect(gate.reason).toMatch(/credentialed PhysioNet user/i);
  });

  it("gives every configured source its own lineage and licence", () => {
    const lineages = new Set(INTAKE_SOURCES.map((s) => s.lineage));
    expect(lineages.size).toBe(INTAKE_SOURCES.length);
    for (const s of INTAKE_SOURCES) {
      expect(s.licence.length).toBeGreaterThan(0);
      expect(s.licenceUrl).toMatch(/^https:/);
    }
  });
});

describe("index parsing", () => {
  it("reads a PhysioNet RECORDS index", () => {
    const files = parseRecordsIndex(
      "# comment\ncase01/eeg.csv\ncase02/eeg.csv\n",
      "https://physionet.org/files/x/1.0.0/RECORDS",
    );
    expect(files).toHaveLength(2);
    expect(files[0]!.url).toBe("https://physionet.org/files/x/1.0.0/case01/eeg.csv");
  });

  it("reads a Zenodo record listing", () => {
    const files = parseZenodoIndex({
      files: [
        { key: "a.csv", size: 10, links: { self: "https://z/a.csv" } },
        { key: "readme.txt", size: 2, links: { self: "https://z/readme.txt" } },
        { key: "broken.csv" },
      ],
    });
    expect(files.map((f) => f.name)).toEqual(["a.csv", "readme.txt"]);
    expect(files[0]!.bytes).toBe(10);
  });
});

describe("planning a run", () => {
  const discovered = [
    { name: "a.csv", url: "https://z/a.csv", bytes: 100 },
    { name: "b.csv", url: "https://z/b.csv", bytes: 100 },
    { name: "notes.txt", url: "https://z/notes.txt", bytes: 10 },
    { name: "huge.csv", url: "https://z/huge.csv", bytes: 999_000_000 },
  ];

  it("skips non-matching, oversized and already-ingested files", () => {
    const plan = planIntake(open, discovered, new Set(["https://z/a.csv"]));
    expect(plan.files.map((f) => f.name)).toEqual(["b.csv"]);
    expect(plan.skippedPattern).toBe(1);
    expect(plan.skippedTooLarge).toBe(1);
    expect(plan.skippedAlreadyIngested).toBe(1);
    expect(plan.files[0]!.caseRef).toBe("b");
  });

  it("plans nothing for an ineligible source", () => {
    const plan = planIntake(restricted, discovered, new Set());
    expect(plan.eligible).toBe(false);
    expect(plan.files).toHaveLength(0);
  });

  it("respects the per-run file cap", () => {
    const plan = planIntake(open, discovered, new Set(), 1);
    expect(plan.files).toHaveLength(1);
  });

  it("derives a stable case reference from a nested path", () => {
    expect(caseRefFromPath("case01/eeg_frontal.csv")).toBe("case01-eeg_frontal");
  });
});

describe("provenance", () => {
  it("records licence, digest and harmonisation for each file", () => {
    const rec = buildProvenance(
      open,
      { name: "a.csv", url: "https://z/a.csv", bytes: 512, digest: "abc" },
      { version: "harmonise-1.0.0", summary: "mastoid → bipolar-frontal" },
      "2026-01-01T00:00:00.000Z",
    );
    expect(rec).toMatchObject({
      intakeVersion: INTAKE_VERSION,
      lineage: open.lineage,
      licence: open.licence,
      digest: "abc",
      bytes: 512,
      harmonizationVersion: "harmonise-1.0.0",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
