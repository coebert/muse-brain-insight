import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { BisBlandAltmanChart } from "./BisBlandAltmanChart";
import type { BisDriftSeriesPoint } from "@/lib/eeg/bis-drift.functions";

beforeAll(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

function point(overrides: Partial<BisDriftSeriesPoint> = {}): BisDriftSeriesPoint {
  return {
    i: 1,
    bis: 50,
    raw: 55,
    corrected: null,
    reliable: true,
    recordedAt: "2026-08-07T12:00:00.000Z",
    sessionId: "s1",
    ...overrides,
  };
}

describe("BisBlandAltmanChart", () => {
  it("renders a summary box with OpenIBIS bias, LOA and paired count", () => {
    const series: BisDriftSeriesPoint[] = Array.from({ length: 10 }, (_, i) =>
      point({ i: i + 1, bis: 50 + i, raw: 55 + i }),
    );
    render(<BisBlandAltmanChart series={series} />);

    expect(screen.getByText("OpenIBIS (pre-correction)")).toBeInTheDocument();
    expect(screen.getAllByText("Bias").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("95 % LOA")).toBeInTheDocument();
    expect(screen.getByText("Paired")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("renders a COEBIS summary box when a correction is present", () => {
    const series: BisDriftSeriesPoint[] = Array.from({ length: 10 }, (_, i) =>
      point({ i: i + 1, bis: 50 + i, raw: 55 + i, corrected: 51 + i }),
    );
    render(<BisBlandAltmanChart series={series} />);

    expect(screen.getByText("COEBIS")).toBeInTheDocument();
    expect(screen.getAllByText("Bias").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("95 % LOA").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Paired").length).toBeGreaterThanOrEqual(2);
  });

  it("shows a placeholder when no COEBIS correction is active", () => {
    const series: BisDriftSeriesPoint[] = Array.from({ length: 10 }, (_, i) =>
      point({ i: i + 1, bis: 50 + i, raw: 55 + i }),
    );
    render(<BisBlandAltmanChart series={series} />);

    expect(screen.getByText(/No active correction for this window/)).toBeInTheDocument();
  });
});
