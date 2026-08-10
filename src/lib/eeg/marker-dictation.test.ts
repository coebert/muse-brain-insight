import { describe, expect, it } from "vitest";
import { composeMarkerLabel, normaliseDictation, normaliseRoute } from "./marker-dictation";

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

  it("keeps drug, dose and route as structured fields and in the label", () => {
    const result = normaliseDictation(
      {
        markers: [
          {
            label: "Rocuronium",
            atSeconds: 60,
            timing: "stated",
            drug: "rocuronium",
            doseValue: 40,
            doseUnit: "mg",
            route: "intravenous",
            quote: "rocuronium 40mg IV at 1 minute",
          },
          { label: "Surgical incision", atSeconds: 120 },
        ],
      },
      600,
    );

    expect(result.markers[0]).toMatchObject({
      label: "Rocuronium 40 mg IV",
      drug: "Rocuronium",
      doseValue: 40,
      doseUnit: "mg",
      route: "IV",
    });
    expect(result.markers[1]?.drug).toBeUndefined();
    expect(result.markers[1]?.label).toBe("Surgical incision");
  });

  it("does not invent a route when none was stated", () => {
    const result = normaliseDictation(
      { markers: [{ label: "x", drug: "fentanyl", doseValue: 100, doseUnit: "mcg", atSeconds: 10 }] },
      600,
    );
    expect(result.markers[0]?.route).toBeUndefined();
    expect(result.markers[0]?.label).toBe("Fentanyl 100 mcg");
  });

  it("normalises written routes and ignores unknown ones", () => {
    expect(normaliseRoute("i.v.")).toBe("IV");
    expect(normaliseRoute("neb")).toBe("nebulised");
    expect(normaliseRoute("Target controlled infusion")).toBe("TCI");
    expect(normaliseRoute("by carrier pigeon")).toBeUndefined();
  });

  it("falls back to the model label when there is no drug", () => {
    expect(
      composeMarkerLabel({
        label: "Facial twitching noted",
        atSeconds: 5,
        timing: "assumed-now",
        quote: "",
      }),
    ).toBe("Facial twitching noted");
  });
});