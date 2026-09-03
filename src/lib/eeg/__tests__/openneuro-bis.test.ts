import { describe, expect, it } from "vitest";

import {
  bisCaseRef,
  mapOpenNeuroBisFile,
  normaliseDatasetId,
  openNeuroBisLineage,
  parseBidsPhysioJson,
  parseMonitorTable,
  parseParticipantsTsv,
  parsePhysioTable,
} from "../openneuro-bis";

describe("openneuro BIS import", () => {
  it("derives a per-dataset lineage", () => {
    expect(openNeuroBisLineage("DS004541")).toBe("external:openneuro:ds004541");
    expect(normaliseDatasetId("openneuro/ds005620")).toBe("ds005620");
  });

  it("parses participants with age, sex and agents", () => {
    const map = parseParticipantsTsv(
      ["participant_id\tage\tsex\tasa\tanesthetic", "sub-02\t67\tM\t3\tpropofol;remifentanil"].join(
        "\n",
      ),
    );
    const p = map.get("sub-02")!;
    expect(p.age).toBe(67);
    expect(p.agents).toEqual(["propofol", "remifentanil"]);
  });

  it("decodes a BIDS physio table using its sidecar clock", () => {
    const meta = parseBidsPhysioJson(
      JSON.stringify({ Columns: ["bis", "sqi"], SamplingFrequency: 1, StartTime: 0 }),
    )!;
    const samples = parsePhysioTable("98\t95\n60\t95\n40\t95\n", meta);
    expect(samples).toHaveLength(3);
    expect(samples[2]!.t).toBe(2);
    expect(samples[1]!.bis).toBe(60);
  });

  it("maps a plain monitor table to quality-filtered reference points", () => {
    const rows = ["time,bis,sqi"];
    for (let t = 0; t < 60; t++) rows.push(`${t},${50 + (t % 3)},${t < 30 ? 90 : 10}`);
    const samples = parseMonitorTable(rows.join("\n"));
    const mapped = mapOpenNeuroBisFile(
      "ds004541",
      "sub-02_ses-01_recording-bis_physio.tsv",
      samples,
      { subject: "sub-02", age: 67, sex: "M", asa: "3", agents: ["propofol"] },
      { strideSeconds: 10, minSqi: 50 },
    );
    expect(mapped.lineage).toBe("external:openneuro:ds004541");
    expect(mapped.caseRef).toBe("ds004541-sub-02_ses-01");
    expect(mapped.points).toHaveLength(3);
    expect(mapped.rejected.lowSqi).toBe(30);
    expect(mapped.covariates.regimen).toBe("propofol_tiva");
    expect(mapped.covariates.ageBand).toBeTruthy();
    expect(new Set(mapped.points.map((p) => p.externalRef)).size).toBe(3);
  });

  it("keeps case refs unique per subject and session", () => {
    expect(bisCaseRef("ds004541", "sub-03_task-anes_recording-bis_physio.tsv.gz")).toBe(
      "ds004541-sub-03",
    );
  });
});
