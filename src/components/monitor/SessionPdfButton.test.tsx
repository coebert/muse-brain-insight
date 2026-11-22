/**
 * Export-boundary regression: the PDF button must forward every research
 * context alias. Collapsing them with `??` hides a conflicting pair and lets
 * the first alias decide the export, which can release depth data that the
 * evidence as a whole does not support.
 */

import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { downloadSessionReportPdf } from "@/lib/eeg/pdf-report";
import { SessionPdfButton } from "./SessionPdfButton";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/privacy", () => ({ unseal: vi.fn(async (rows: unknown) => rows) }));
vi.mock("@/lib/eeg/db-rows", () => ({
  fetchEpochs: vi.fn(async () => []),
  fetchEvents: vi.fn(async () => []),
}));
vi.mock("@/lib/eeg/pdf-report", () => ({
  downloadSessionReportPdf: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { loading: () => 1, success: vi.fn(), error: vi.fn() },
}));

const eligibleContext = {
  blockade: "reported-absent",
  caseId: "case-1",
  acquiredAt: "2026-11-21T12:00:00Z",
  reference: "mastoid",
  absenceDocumented: true,
  montageCompatible: true,
  referenceCompatible: true,
  calibrationCompatible: true,
  coverageAdequate: true,
  status: "research score",
};

const download = vi.mocked(downloadSessionReportPdf);

function renderButton(session: Record<string, unknown>) {
  render(<SessionPdfButton sessionId="session-1" session={session as never} />);
  fireEvent.click(document.querySelector("button")!);
}

beforeEach(() => {
  download.mockClear();
});

describe("SessionPdfButton evidence aliases", () => {
  it("withholds depth when the two context aliases conflict", async () => {
    renderButton({
      case_code: "CASE-1",
      researchContext: eligibleContext,
      research_context: "documented",
    });

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0]![0]).toMatchObject({ descriptorOnly: true });
  });

  it("withholds when one alias is withheld and the other is eligible", async () => {
    renderButton({
      case_code: "CASE-1",
      researchContext: null,
      research_context: eligibleContext,
    });

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0]![0]).toMatchObject({ descriptorOnly: true });
  });

  it("exports depth for a single, fully evidenced context", async () => {
    renderButton({ case_code: "CASE-1", researchContext: eligibleContext });

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0]![0]).toMatchObject({ descriptorOnly: false });
  });
});
