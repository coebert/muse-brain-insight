import { describe, expect, it } from "vitest";

import {
  CHENNU_LINEAGE,
  CHENNU_SOURCE,
  chennuCaseRef,
  chennuLabel,
  chennuLevelFromName,
  parseChennuBlock,
  toChennuRows,
} from "../chennu";
import { collapseState } from "../state-labels";

function rawCsv(seconds = 8, rate = 250): string {
  const lines = ["time,e1"];
  for (let i = 0; i < seconds * rate; i++) {
    const t = i / rate;
    lines.push(`${t.toFixed(4)},${(20 * Math.sin(2 * Math.PI * 10 * t)).toFixed(3)}`);
  }
  return lines.join("\n");
}

describe("chennuLabel", () => {
  it("keeps the drug level and the behaviour apart", () => {
    expect(chennuLabel("baseline", "unknown")).toBe("awake");
    expect(chennuLabel("moderate", "responsive")).toBe("sedated_responsive");
    expect(chennuLabel("moderate", "unresponsive")).toBe("sedated_unresponsive");
    expect(chennuLabel("mild", "unknown")).toBe("sedated");
    expect(chennuLabel("recovery", "unknown")).toBe("emergence");
  });

  it("lands on the right side of the responsiveness fit", () => {
    expect(collapseState(chennuLabel("moderate", "responsive"))).toBe("responsive");
    expect(collapseState(chennuLabel("moderate", "unresponsive"))).toBe("unresponsive");
    expect(collapseState(chennuLabel("mild", "unknown"))).toBeNull();
  });
});

describe("file naming", () => {
  it("reads the volunteer and the level off the filename", () => {
    expect(chennuCaseRef("S07_moderate.csv")).toBe("S07");
    expect(chennuLevelFromName("S07_moderate.csv")).toBe("moderate");
    expect(chennuLevelFromName("S07_baseline.csv")).toBe("baseline");
    expect(chennuLevelFromName("S07_block2.csv")).toBeNull();
  });
});

describe("parseChennuBlock", () => {
  const meta = { caseRef: "S07", level: "moderate" as const, response: "unresponsive" as const };

  it("stamps the block label on every derived epoch", () => {
    const epochs = parseChennuBlock(rawCsv(), "raw", meta);
    expect(epochs.length).toBeGreaterThan(0);
    expect(epochs.every((e) => e.label === "sedated_unresponsive")).toBe(true);
    expect(epochs.every((e) => e.labelSource === "dataset")).toBe(true);
    expect(epochs[0]!.externalRef.startsWith(`${CHENNU_SOURCE}:S07:moderate`)).toBe(true);
  });

  it("gives every epoch its own reference", () => {
    const epochs = parseChennuBlock(rawCsv(), "raw", meta);
    expect(new Set(epochs.map((e) => e.externalRef)).size).toBe(epochs.length);
  });

  it("files rows under their own lineage with the drug covariates", () => {
    const rows = toChennuRows(parseChennuBlock(rawCsv(), "raw", meta), {
      ...meta,
      plasmaUgMl: 1.3,
    });
    expect(rows[0]!.sourceLineage).toBe(CHENNU_LINEAGE);
    expect(rows[0]!.covariates["target_propofol_ug_ml"]).toBe(1.2);
    expect(rows[0]!.covariates["plasma_propofol_ug_ml"]).toBe(1.3);
    expect(rows[0]!.covariates["responsiveness"]).toBe("unresponsive");
  });
});
