import { describe, expect, it } from "vitest";

import { EegAnalyzer, EPOCH_SECONDS, type Epoch, type DetectedEvent } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";

const FS = MUSE_SAMPLE_RATE;

/**
 * Deterministic pseudo-random generator so the synthetic baseline is
 * reproducible across runs (vitest has no seeded Math.random).
 */
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
}

/** Non-rhythmic background EEG: builds a line-length baseline, scores low. */
function baselineWindow(t0 = 0): Float64Array {
  const n = Math.round(FS * EPOCH_SECONDS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / FS;
    out[i] = 14 * rnd() + 6 * Math.sin(2 * Math.PI * 23.7 * t) + 4 * Math.sin(2 * Math.PI * 31 * t);
  }
  return out;
}

/** High-amplitude rhythmic 3.5 Hz activity: scores well above threshold. */
function ictalWindow(t0 = 0): Float64Array {
  const n = Math.round(FS * EPOCH_SECONDS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / FS;
    out[i] = 70 * Math.sin(2 * Math.PI * 3.5 * t) + 35 * Math.sin(2 * Math.PI * 7 * t);
  }
  return out;
}

function seizures(a: EegAnalyzer): DetectedEvent[] {
  return a.events.filter((e) => e.kind === "seizure");
}

/** Feeds a run of epochs and returns them. */
function feed(
  a: EegAnalyzer,
  from: number,
  to: number,
  gen: (t: number) => Float64Array,
): Epoch[] {
  const out: Epoch[] = [];
  for (let t = from; t < to; t++) out.push(a.analyze(gen(t), t));
  return out;
}

describe("seizure episode boundaries vs data gaps", () => {
  it("scores an ictal run and alerts on continuous data", () => {
    const a = new EegAnalyzer();
    feed(a, 0, 80, baselineWindow);
    const ictal = feed(a, 80, 90, ictalWindow);
    expect(ictal.some((e) => e.seizureAlert)).toBe(true);
    expect(Math.max(...ictal.map((e) => e.seizureScore))).toBeGreaterThan(0.62);
  });

  it("closes an in-progress episode at the last valid epoch, never inside the gap", () => {
    const a = new EegAnalyzer();
    feed(a, 0, 80, baselineWindow);
    feed(a, 80, 90, ictalWindow);
    const gapStart = 89; // last recorded epoch
    const gapEnd = 300;
    a.analyze(baselineWindow(gapEnd), gapEnd);

    const [ep] = seizures(a);
    expect(ep).toBeDefined();
    expect(ep!.t).toBeGreaterThanOrEqual(0);
    expect(ep!.t).toBeLessThanOrEqual(gapStart);
    // The episode must terminate at or before the last valid epoch.
    expect(ep!.t + ep!.duration).toBeLessThanOrEqual(gapStart);
    // It must not be stretched across the 211 s dropout.
    expect(ep!.duration).toBeLessThan(gapEnd - gapStart);
  });

  it("produces no score, no alert and no episode inside gap-affected epochs", () => {
    const a = new EegAnalyzer();
    feed(a, 0, 80, baselineWindow);
    feed(a, 80, 90, ictalWindow);
    const before = seizures(a).length;

    // Dropout, then ictal-looking data returns: the recovery epochs still
    // contain pre-gap samples and must be inert.
    const resumed = a.analyze(ictalWindow(300), 300);
    expect(resumed.gapAffected).toBe(true);
    expect(resumed.seizureScore).toBe(0);
    expect(resumed.seizureAlert).toBe(false);

    for (let t = 301; t <= 303; t++) {
      const e = a.analyze(ictalWindow(t), t);
      expect(e.gapAffected).toBe(true);
      expect(e.seizureScore).toBe(0);
      expect(e.seizureAlert).toBe(false);
    }

    // Exactly one episode was filed (closed at the gap edge) and none of its
    // boundaries land within the gap window.
    const after = seizures(a);
    expect(after.length).toBe(before + 1);
    for (const ev of after) {
      expect(ev.t).toBeLessThan(300);
      expect(ev.t + ev.duration).toBeLessThan(300);
    }
  });

  it("never back-dates an onset before the first valid epoch after a gap", () => {
    const a = new EegAnalyzer();
    feed(a, 0, 80, baselineWindow);
    // Long dropout with no episode in progress.
    const gapEnd = 400;
    let firstValidT: number | null = null;
    for (let t = gapEnd; t < gapEnd + 20; t++) {
      const e = a.analyze(ictalWindow(t), t);
      if (!e.gapAffected && firstValidT === null) firstValidT = t;
    }
    expect(firstValidT).not.toBeNull();
    // Terminate the run so the episode is filed.
    feed(a, gapEnd + 20, gapEnd + 22, baselineWindow);

    const ep = seizures(a).at(-1);
    expect(ep).toBeDefined();
    // Back-dating by the run length would land inside the gap; it must clamp.
    expect(ep!.t).toBeGreaterThanOrEqual(firstValidT!);
  });

  it("splits a run that straddles a gap into two episodes on either side", () => {
    const a = new EegAnalyzer();
    feed(a, 0, 80, baselineWindow);
    // Threshold already crossed and the alert latched before the dropout.
    feed(a, 80, 90, ictalWindow);
    // Dropout, then the same ictal pattern continues.
    const gapEnd = 500;
    for (let t = gapEnd; t < gapEnd + 20; t++) a.analyze(ictalWindow(t), t);
    feed(a, gapEnd + 20, gapEnd + 22, baselineWindow);

    const eps = seizures(a);
    expect(eps.length).toBe(2);
    const [first, second] = eps;
    expect(first!.t + first!.duration).toBeLessThan(gapEnd);
    expect(second!.t).toBeGreaterThanOrEqual(gapEnd);
    // No single episode spans the dropout.
    for (const ev of eps) {
      const spansGap = ev.t < 90 && ev.t + ev.duration > gapEnd;
      expect(spansGap).toBe(false);
    }
  });

  it("does not let threshold crossings during a gap accumulate a run", () => {
    const a = new EegAnalyzer();
    feed(a, 0, 80, baselineWindow);
    // Two ictal epochs — one short of the 3-epoch requirement.
    feed(a, 80, 82, ictalWindow);
    expect(seizures(a).length).toBe(0);

    // Dropout, then two more ictal epochs that are still gap-affected: they
    // must not top up the earlier partial run into an alert.
    const gapEnd = 600;
    const e1 = a.analyze(ictalWindow(gapEnd), gapEnd);
    const e2 = a.analyze(ictalWindow(gapEnd + 1), gapEnd + 1);
    expect(e1.seizureAlert).toBe(false);
    expect(e2.seizureAlert).toBe(false);
    expect(seizures(a).length).toBe(0);
  });
});
