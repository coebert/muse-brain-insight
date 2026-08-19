import { describe, expect, it } from "vitest";

import {
  generatePseudonym,
  mergeFindings,
  normaliseIdentifier,
  scrubCaseText,
  scrubText,
  summariseFindings,
} from "./deid";

describe("scrubText", () => {
  it("removes NHS numbers in spaced and unspaced form", () => {
    expect(scrubText("NHS 943 476 5919").text).toContain("[NHS-NUMBER REMOVED]");
    expect(scrubText("nhs 9434765919").text).toContain("[NHS-NUMBER REMOVED]");
  });

  it("removes hospital numbers and labelled MRNs", () => {
    expect(scrubText("MRN: RXH1234567").text).not.toMatch(/1234567/);
    expect(scrubText("Hospital no. 88231145").text).not.toMatch(/88231145/);
  });

  it("removes dates of birth in several formats", () => {
    for (const dob of ["12/03/1948", "1948-03-12", "12 March 1948"]) {
      expect(scrubText(`DOB ${dob}`).text).toContain("[DATE REMOVED]");
    }
  });

  it("removes emails, phone numbers and postcodes", () => {
    expect(scrubText("ring 020 7188 7188").text).toContain("[PHONE REMOVED]");
    expect(scrubText("a.smith@nhs.net").text).toContain("[EMAIL REMOVED]");
    expect(scrubText("lives at SE1 9RT").text).toContain("[POSTCODE REMOVED]");
  });

  it("removes labelled patient names", () => {
    expect(scrubText("Patient: John Smith, laparotomy").text).toContain("[NAME REMOVED]");
    expect(scrubText("Mrs Jane Doe for section").text).toContain("[NAME REMOVED]");
  });

  it("keeps clinical vocabulary that merely looks like a name", () => {
    const out = scrubText("Burst Suppression seen in Theatre Four during Propofol Ketamine");
    expect(out.text).toContain("Burst Suppression");
    expect(out.findings.some((f) => f.kind === "name")).toBe(false);
  });

  it("leaves clean clinical text untouched", () => {
    const text = "Frail 84-year-old, emergency laparotomy, deep suppression at low propofol Ce.";
    const out = scrubText(text);
    expect(out.text).toBe(text);
    expect(out.findings).toEqual([]);
  });

  it("counts each removal", () => {
    const out = scrubText("a@nhs.net and b@nhs.net");
    expect(out.findings).toEqual([{ kind: "email", count: 2 }]);
  });

  it("handles empty input", () => {
    expect(scrubText("").findings).toEqual([]);
    expect(scrubText(null).text).toBe("");
  });
});

describe("scrubCaseText", () => {
  it("cleans every field and pools the findings", () => {
    const out = scrubCaseText({
      notes: "call 020 7188 7188",
      caseSummary: "DOB 12/03/1948",
      location: "Theatre 4",
      diagnosis: null,
    });
    expect(out.fields.notes).toContain("[PHONE REMOVED]");
    expect(out.fields.caseSummary).toContain("[DATE REMOVED]");
    expect(out.fields.location).toBe("Theatre 4");
    expect(out.fields.diagnosis).toBeNull();
    expect(out.findings.map((f) => f.kind).sort()).toEqual(["date", "phone"]);
  });
});

describe("mergeFindings / summariseFindings", () => {
  it("pools counts across fields", () => {
    expect(
      mergeFindings([
        [{ kind: "date", count: 1 }],
        [
          { kind: "date", count: 2 },
          { kind: "name", count: 1 },
        ],
      ]),
    ).toEqual([
      { kind: "date", count: 3 },
      { kind: "name", count: 1 },
    ]);
  });

  it("reads as plain clinical English", () => {
    expect(summariseFindings([])).toBe("No identifiers detected.");
    expect(summariseFindings([{ kind: "name", count: 1 }])).toBe("Removed 1 name.");
    expect(summariseFindings([{ kind: "date", count: 2 }])).toBe("Removed 2 dates.");
  });
});

describe("patient linkage helpers", () => {
  it("normalises identifiers so one patient links once", () => {
    expect(normaliseIdentifier(" rxh 123-4567 ")).toBe("RXH1234567");
    expect(normaliseIdentifier("RXH1234567")).toBe(normaliseIdentifier("rxh 123 4567"));
  });

  it("mints unambiguous pseudonyms", () => {
    const code = generatePseudonym(() => 0.5);
    expect(code).toMatch(/^PT-[ACDEFGHJKLMNPQRTUVWXY34679]{4}$/);
    expect(code).not.toMatch(/[OI01S5BZ]/);
  });
});
