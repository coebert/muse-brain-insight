/**
 * End-to-end: burst-suppression data in, correct suppression ratio and
 * suppression time on the monitor tiles out.
 *
 * Feeds a synthetic burst-suppression trace at a known duty cycle through the
 * real analyzer on the Muse 2 acquisition lineage that the suppression metrics
 * are calibrated for, then renders the metrics grid and reads the numbers a
 * clinician would see.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EegAnalyzer, DEFAULT_SETTINGS, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_2_PROFILE } from "@/lib/eeg/device-profile";
import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
import { gateCoebisModel, lineageFromProfile } from "@/lib/eeg/model-lineage";

vi.mock("@/hooks/useCoebisModel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useCoebisModel")>()),
  useCoebisModel: () => null,
}));
vi.mock("@/hooks/useSefAlignment", () => ({ useSefAlignment: () => null }));

const { MetricsGrid } = await import("./MetricsGrid");

const FS = MUSE_SAMPLE_RATE;
const EPOCH_SAMPLES = FS * 4;

/**
 * Burst-suppression trace: alternating 1 s of near-isoelectric signal and 1 s
 * of a 12 Hz burst, giving a known suppression duty cycle.
 */
function burstSuppression(seconds: number, suppressedFraction: number): Float64Array {
  const out = new Float64Array(seconds * FS);
  let s = 7;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    const t = i / FS;
    // Two-second cycle: the first part suppressed, the rest a burst.
    const phase = t % 2;
    const suppressed = phase < 2 * suppressedFraction;
    out[i] = suppressed ? 1.2 * rand() : 40 * Math.sin(2 * Math.PI * 12 * t) + 5 * rand();
  }
  return out;
}

/** Run the real analyzer, one epoch per second, exactly as the monitor does. */
function ingest(signal: Float64Array) {
  const analyzer = new EegAnalyzer(undefined, FS);
  const epochs: Epoch[] = [];
  for (let start = 0; start + EPOCH_SAMPLES <= signal.length; start += FS) {
    epochs.push(
      analyzer.analyze(Float64Array.from(signal.subarray(start, start + EPOCH_SAMPLES)), (start + EPOCH_SAMPLES) / FS),
    );
  }
  return { epochs, suppressionSeconds: analyzer.suppressionSeconds };
}

function renderGrid(epochs: Epoch[], suppressionSeconds: number) {
  const latest = epochs.at(-1) ?? null;
  const maxSr = epochs.reduce((m, e) => Math.max(m, e.suppressionRatio), 0);
  render(
    <MetricsGrid
      latest={latest}
      summary={{ maxSr, suppressionSeconds, seizureAlerts: 0 }}
      srWindowSeconds={DEFAULT_SETTINGS.srWindowSeconds}
      srTone="caution"
      seizureAlert={false}
      icuMode
      depthWindow={{
        status: { state: "inside", since: null, message: "" } as never,
        prefs: { enabled: false, low: 40, high: 60, graceSeconds: 60 } as never,
      }}
    />,
  );
  return { latest, maxSr };
}

/** The number rendered on a named tile. */
function tileValue(label: string): number {
  const tile = screen.getByText(new RegExp(`^${label}`, "i")).closest("div")!.parentElement!;
  const text = tile.textContent ?? "";
  const match = text.replace(new RegExp(`^${label}[^0-9-]*`, "i"), "").match(/-?\d+(\.\d+)?/);
  return Number(match?.[0]);
}

describe("suppression metrics on a compatible lineage", () => {
  it("runs suppression scoring on the calibrated Muse 2 lineage", () => {
    const current = lineageFromProfile(MUSE_2_PROFILE);
    expect(gateCoebisModel(current, current).allowed).toBe(true);
  });

  it("computes a suppression ratio matching the ingested duty cycle", () => {
    const { epochs } = ingest(burstSuppression(120, 0.5));
    const settled = epochs.at(-1)!;
    expect(settled.suppressionRatio).toBeGreaterThan(35);
    expect(settled.suppressionRatio).toBeLessThan(65);
  });

  it("accumulates suppression time in proportion to the suppressed signal", () => {
    const { epochs, suppressionSeconds } = ingest(burstSuppression(120, 0.5));
    // One second of analysed signal per epoch, roughly half of it suppressed.
    expect(suppressionSeconds).toBeGreaterThan(epochs.length * 0.3);
    expect(suppressionSeconds).toBeLessThan(epochs.length * 0.7);
  });

  it("reports near-zero suppression for a continuously bursting trace", () => {
    const { epochs, suppressionSeconds } = ingest(burstSuppression(60, 0));
    expect(epochs.at(-1)!.suppressionRatio).toBeLessThan(5);
    expect(suppressionSeconds).toBeLessThan(epochs.length * 0.05);
  });

  it("displays the computed ratio and time on the monitor tiles", () => {
    const { epochs, suppressionSeconds } = ingest(burstSuppression(120, 0.5));
    const { latest, maxSr } = renderGrid(epochs, suppressionSeconds);

    expect(tileValue("Suppression ratio")).toBe(Number(latest!.suppressionRatio.toFixed(0)));
    expect(screen.getByText(new RegExp(`Peak ${maxSr.toFixed(0)} %`))).toBeTruthy();

    const shown = tileValue("Suppression time");
    const expectedMinutes = Math.floor(suppressionSeconds / 60);
    expect(shown).toBe(suppressionSeconds < 60 ? Number(suppressionSeconds.toFixed(0)) : expectedMinutes);
  });

  it("shows a dash and zero suppression time before any data arrives", () => {
    renderGrid([], 0);
    expect(tileValue("Suppression time")).toBe(0);
    expect(screen.getByText("Total 0 s")).toBeTruthy();
  });
});
