import { describe, expect, it } from "vitest";
import { normaliseDictation } from "./marker-dictation";

describe("normaliseDictation", () => {
  it("orders several events from one entry chronologically", () => {
    const result = normaliseDictation(
      {
        markers: [
          { label: "Facial twitching noted", atSeconds: 600, timing: "assumed-now" },
          { label: "Rocuronium 40 mg", atSeconds: 60, timing: "stated" },
          { label: "Surgical incision", atSeconds: 480, timing: "relative" },
          { label: "Propofol 100 mg", atSeconds: 30, timing: "stated" },
        ],
      },
      600,
    );

    expect(result.markers.map((m) => m.label)).toEqual([
      "Propofol 100 mg",
      "Rocuronium 40 mg",
      "Surgical incision",
      "Facial twitching noted",
    ]);
  });

  it("keeps written order for events sharing a timestamp", () => {
    const result = normaliseDictation(
      {
        markers: [
          { label: "Alfentanil 500 mcg", atSeconds: 120 },
          { label: "Rocuronium 50 mg", atSeconds: 120 },
        ],
      },
      600,
    );
    expect(result.markers.map((m) => m.label)).toEqual(["Alfentanil 500 mcg", "Rocuronium 50 mg"]);
  });

  it("clamps times into the recording and drops repeated events", () => {
    const result = normaliseDictation(
      {
        markers: [
          { label: "Ketamine bolus", atSeconds: 9000 },
          { label: "ketamine bolus", atSeconds: 9000 },
          { label: "Line inserted", atSeconds: -40 },
          { label: "" },
        ],
        unmatched: ["patient looks settled"],
      },
      300,
    );

    expect(result.markers).toHaveLength(2);
    expect(result.markers[0]).toMatchObject({ label: "Line inserted", atSeconds: 0 });
    expect(result.markers[1]).toMatchObject({ label: "Ketamine bolus", atSeconds: 300 });
    expect(result.unmatched).toEqual(["patient looks settled"]);
  });
});