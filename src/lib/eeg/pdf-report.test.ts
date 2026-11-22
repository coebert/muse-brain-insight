/**
 * PDF-boundary regressions for the descriptor-only policy.
 *
 * The export must fail closed on an omitted eligibility verdict, and a stale
 * model note must not smuggle a patient-state claim into the footer. These
 * tests build the real jsPDF document with synthetic stored depths and read
 * back the text actually drawn into it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { jsPDF } from "jspdf";

import type { EpochRow, EventRow } from "./db-rows";
import { buildSessionReportPdf } from "./pdf-report";

/** jsdom has no canvas backend; the charts only need a context and a box. */
function stubCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "createImageData")
          return (w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          });
        if (prop === "canvas") return null;
        if (prop === "measureText") return () => ({ width: 10 });
        return () => undefined;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as RenderingContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
  // addImage is a plugin method copied onto each instance at construction, so
  // it is patched on the static API before the document is built.
  const api = (jsPDF as unknown as { API: { addImage: (...args: unknown[]) => jsPDF } }).API;
  vi.spyOn(api, "addImage").mockImplementation(function (this: jsPDF) {
    return this;
  } as never);
}

/**
 * Read the text-showing operators back out of the generated PDF, so the
 * assertions run against the actual document rather than a mock of `text`.
 */
function readPdfText(doc: jsPDF): string[] {
  const raw = doc.output() as string;
  const out: string[] = [];
  const pattern = /\((?:\\.|[^\\()])*\)\s*Tj/g;
  for (const match of raw.match(pattern) ?? []) {
    const inner = match.slice(1, match.lastIndexOf(")"));
    out.push(inner.replace(/\\([()\\])/g, "$1"));
  }
  return out;
}

function epoch(over: Partial<EpochRow> = {}): EpochRow {
  return {
    t_offset_seconds: 0,
    depth_index: 23,
    spectral_edge_95: 9.4,
    suppression_ratio: 12,
    seizure_score: 0.1,
    is_suppressed: false,
    consciousness_index: null,
    nociception_index: null,
    entropy: null,
    spectrum: [],
    depth_components: null,
    ...over,
  } as unknown as EpochRow;
}

const epochs = [
  epoch({ t_offset_seconds: 0 }),
  epoch({ t_offset_seconds: 1 }),
  epoch({ t_offset_seconds: 2 }),
];
const events: EventRow[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSessionReportPdf depth eligibility", () => {
  it("withholds synthetic stored depths when the verdict is omitted", () => {
    stubCanvas();

    const doc = buildSessionReportPdf({ session: { case_code: "CASE-1" }, epochs, events });
    const drawn = readPdfText(doc);

    expect(drawn.join("\n")).toContain("Withheld (research descriptor only)");
    expect(drawn).not.toContain("23");
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });

  it("withholds synthetic stored depths when the verdict is explicitly true", () => {
    stubCanvas();

    const doc = buildSessionReportPdf({
      session: { case_code: "CASE-1" },
      epochs,
      events,
      descriptorOnly: true,
    });
    const drawn = readPdfText(doc);

    expect(drawn.join("\n")).toContain("Withheld (research descriptor only)");
    expect(drawn).not.toContain("23");
  });

  it("exports the depth descriptor only for an explicit eligible verdict", () => {
    stubCanvas();

    const doc = buildSessionReportPdf({
      session: { case_code: "CASE-1" },
      epochs,
      events,
      descriptorOnly: false,
    });
    const drawn = readPdfText(doc);

    expect(drawn).toContain("23");
    expect(drawn.join("\n")).not.toContain("Withheld (research descriptor only)");
  });
});

describe("buildSessionReportPdf footer", () => {
  it("replaces a stale patient-state model note when depth is withheld", () => {
    stubCanvas();

    const doc = buildSessionReportPdf({
      session: { case_code: "CASE-1" },
      epochs,
      events,
      descriptorOnly: true,
      modelNote: "The patient is unconscious.",
    });
    const footer = readPdfText(doc).find((line) => line.includes("page 1 of"));

    expect(footer).toBeDefined();
    expect(footer).not.toMatch(/unconscious/i);
    expect(footer).toContain("CortexTrace");
  });

  it("keeps an ordinary model note when the verdict is eligible", () => {
    stubCanvas();

    const doc = buildSessionReportPdf({
      session: { case_code: "CASE-1" },
      epochs,
      events,
      descriptorOnly: false,
      modelNote: "COEBIS v2 pooled fit",
    });
    const footer = readPdfText(doc).find((line) => line.includes("page 1 of"));

    expect(footer).toContain("COEBIS v2 pooled fit");
  });
});
