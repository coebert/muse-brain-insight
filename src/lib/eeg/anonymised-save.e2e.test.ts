/**
 * End-to-end: ingest a case, save it, read it back, prove nothing identifying
 * was stored.
 *
 * Synthetic Muse 2 samples are pushed through the real analyzer, the resulting
 * case is saved through the real `saveSession` path (real de-identification,
 * real AES-256-GCM sealing, real pseudonym linkage) into an in-memory stand-in
 * for the database, and every stored row is then retrieved and searched for
 * direct identifiers. If any layer of the anonymisation chain regresses, the
 * identifier appears in the stored payload and this test fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env["PHI_ENCRYPTION_KEY"] ??= "test-phi-key-for-vitest";

import { EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
import { generatePseudonym, normaliseIdentifier } from "@/lib/eeg/deid";
import { open, seal } from "@/lib/privacy.server";

/* ------------------------------------------------------------------ */
/* In-memory stand-in for the stored record                            */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = {};

function reset() {
  for (const key of Object.keys(store)) delete store[key];
}

function insert(table: string, rows: Row | Row[]) {
  const list = Array.isArray(rows) ? rows : [rows];
  const stored = list.map((r, i) => ({ id: `${table}-${(store[table]?.length ?? 0) + i + 1}`, ...r }));
  store[table] = [...(store[table] ?? []), ...stored];
  return stored;
}

function fakeFrom(table: string) {
  return {
    insert(rows: Row | Row[]) {
      const stored = insert(table, rows);
      const result = { data: null as unknown, error: null };
      return {
        select: () => ({
          single: async () => ({ data: { id: stored[0]!["id"] }, error: null }),
          maybeSingle: async () => ({ data: stored[0] ?? null, error: null }),
        }),
        then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
    },
  };
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: "clinician-1" } } }) },
    from: (table: string) => fakeFrom(table),
  },
}));

// Server functions cannot run in the test runtime, so they are backed by the
// same real server-side implementations they call in production.
vi.mock("@/lib/privacy.functions", () => ({
  sealTexts: async ({ data }: { data: { values: (string | null)[] } }) => ({
    values: data.values.map((v) => seal(v)),
  }),
  openTexts: async ({ data }: { data: { values: (string | null)[] } }) => ({
    values: data.values.map((v) => open(v)),
  }),
}));

vi.mock("@/lib/eeg/patient-link.functions", () => ({
  linkPatient: async ({ data }: { data: { identifier: string } }) => {
    const normalised = normaliseIdentifier(data.identifier);
    const pseudonym = generatePseudonym();
    const [row] = insert("patient_links", {
      user_id: "clinician-1",
      pseudonym,
      identifier_sealed: seal(normalised),
    });
    return { id: row!["id"], pseudonym, createdAt: new Date().toISOString(), created: true };
  },
}));

const { saveSession } = await import("@/lib/eeg/save");

/* ------------------------------------------------------------------ */
/* Synthetic acquisition                                               */
/* ------------------------------------------------------------------ */

const FS = MUSE_SAMPLE_RATE;
const EPOCH_SAMPLES = FS * 4;

function museChannel(seconds: number): Float64Array {
  const out = new Float64Array(seconds * FS);
  let s = 7;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    out[i] = 30 * Math.sin((2 * Math.PI * 10 * i) / FS) + 4 * rand();
  }
  return out;
}

function ingest(seconds: number): Epoch[] {
  const analyzer = new EegAnalyzer(undefined, FS);
  const signal = museChannel(seconds);
  const epochs: Epoch[] = [];
  for (let start = 0; start + EPOCH_SAMPLES <= signal.length; start += FS) {
    epochs.push(
      analyzer.analyze(
        Float64Array.from(signal.subarray(start, start + EPOCH_SAMPLES)),
        (start + EPOCH_SAMPLES) / FS,
      ),
    );
  }
  return epochs;
}

/** Every direct identifier typed into the case by the clinician. */
const IDENTIFIERS = [
  "RXH1234567",
  "RXH 123 4567",
  "9434765919",
  "943 476 5919",
  "John Smith",
  "12/03/1948",
  "j.smith@nhs.net",
  "020 7188 7188",
  "SE1 9RT",
];

const META = {
  caseCode: "GA-260821-K7QF",
  context: "general_anaesthesia",
  patientIdentifier: "RXH 123 4567",
  location: "Theatre 4",
  notes: "Patient: John Smith, NHS 943 476 5919, DOB 12/03/1948. Ring 020 7188 7188.",
  caseSummary: "Frail patient, emergency laparotomy. Contact j.smith@nhs.net, lives at SE1 9RT.",
  deviceName: "Muse-1234",
  ageYears: "94",
  sex: "female",
  admissionDiagnosis: "Sepsis, MRN: RXH1234567",
  clinicalFeatures: ["Sepsis", "Delirium"],
  regimen: "propofol_remifentanil",
  frailty: "frail",
};

async function saveIngestedCase() {
  const epochs = ingest(20);
  const id = await saveSession(
    META,
    epochs,
    [{ kind: "seizure", severity: "warning", t: 12, duration: 4, detail: "rhythmic activity" } as never],
    { meanSr: 3.2, maxSr: 11.4, suppressionSeconds: 6.5, seizureAlerts: 1 },
    epochs.length,
    Date.UTC(2026, 7, 21, 8, 0, 0),
  );
  return { id, epochs };
}

/** Everything that reached the database, exactly as stored. */
const storedText = () => JSON.stringify(store);

/* ------------------------------------------------------------------ */

describe("ingest → save → retrieve keeps the record anonymous", () => {
  beforeEach(reset);

  it("stores the ingested epochs and events against the saved case", async () => {
    const { id, epochs } = await saveIngestedCase();
    expect(store["eeg_sessions"]).toHaveLength(1);
    expect(store["eeg_epochs"]).toHaveLength(epochs.length);
    expect(store["eeg_events"]).toHaveLength(1);
    expect(store["eeg_epochs"]!.every((r) => r["session_id"] === id)).toBe(true);
    expect(store["eeg_epochs"]![0]!["spectrum"]).toBeInstanceOf(Array);
  });

  it("stores no direct identifier anywhere in the record", async () => {
    await saveIngestedCase();
    const text = storedText();
    for (const identifier of IDENTIFIERS) {
      expect(text).not.toContain(identifier);
      expect(text).not.toContain(identifier.replace(/[\s-]/g, ""));
    }
    // Nor the case code the clinician typed, which is sealed like any free text.
    expect(text).not.toContain(META.caseCode);
  });

  it("keeps the patient reachable only through a pseudonym", async () => {
    await saveIngestedCase();
    const session = store["eeg_sessions"]![0]!;
    expect(session["patient_pseudonym"]).toMatch(/^PT-[A-Z0-9]{4}$/);
    expect(session["patient_link_id"]).toBe(store["patient_links"]![0]!["id"]);
    // The linkage row holds the identifier sealed, never in the clear.
    const sealed = store["patient_links"]![0]!["identifier_sealed"] as string;
    expect(sealed.startsWith("enc.v1.")).toBe(true);
    expect(open(sealed)).toBe("RXH1234567");
  });

  it("reduces the demographics it does keep to non-identifying bands", async () => {
    await saveIngestedCase();
    const session = store["eeg_sessions"]![0]!;
    expect(session["age_years"]).toBeNull(); // 90+ is never stored exactly
    expect(session["age_band"]).toBe("90+");
    expect(session["sex"]).toBe("female");
    expect(session["clinical_features"]).toEqual(["Sepsis", "Delirium"]);
  });

  it("retrieves the case with identifiers scrubbed but clinical meaning intact", async () => {
    await saveIngestedCase();
    const session = store["eeg_sessions"]![0]!;
    const notes = open(session["notes"] as string) ?? "";
    const summary = open(session["case_summary"] as string) ?? "";
    const diagnosis = open(session["admission_diagnosis"] as string) ?? "";

    expect(notes).toContain("[NAME REMOVED]");
    expect(notes).toContain("[NHS-NUMBER REMOVED]");
    expect(notes).toContain("[DATE REMOVED]");
    expect(notes).toContain("[PHONE REMOVED]");
    expect(summary).toContain("[EMAIL REMOVED]");
    expect(summary).toContain("[POSTCODE REMOVED]");
    expect(summary).toContain("emergency laparotomy");
    expect(diagnosis).toContain("Sepsis");
    for (const identifier of IDENTIFIERS) {
      expect(`${notes} ${summary} ${diagnosis}`).not.toContain(identifier);
    }
  });

  it("records what was removed so the clinician can audit the save", async () => {
    await saveIngestedCase();
    const findings = store["eeg_sessions"]![0]!["deid_findings"] as { kind: string; count: number }[];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["nhs_number", "email"]));
    expect(findings.every((f) => f.count > 0)).toBe(true);
  });

  it("stores every free-text column encrypted, never as plain text", async () => {
    await saveIngestedCase();
    const session = store["eeg_sessions"]![0]!;
    for (const field of ["case_code", "location", "notes", "case_summary", "admission_diagnosis"]) {
      expect(String(session[field])).toMatch(/^enc\.v1\./);
    }
    expect(open(session["case_code"] as string)).toBe(META.caseCode);
  });
});
