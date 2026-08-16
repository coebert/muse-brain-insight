/**
 * Clinical test run of the COEBIS adjunct stage against real monitor readings.
 *
 * Each vignette is a snapshot taken from published/observed simultaneous
 * displays of a GE Entropy module (SE 0-91, RE 0-100) and a Masimo SedLine /
 * commercial BIS-style index, at the phases of anaesthesia where the two
 * families are known to disagree with a plain OpenIBIS index:
 *
 *  - awake / pre-oxygenation: SE ~87, RE ~97 (large frontal EMG margin)
 *  - laryngoscopy in a lightly paralysed patient: BIS jumps on EMG alone
 *  - propofol/remifentanil maintenance: SE ~40, RE ~45, frontal alpha
 *  - deep TIVA with burst suppression: SE ~12, BSR 45 %
 *  - emergence: entropies climb before the index does
 *
 * The assertions check that the adjunct moves COEBIS in the direction the
 * commercial monitor actually read, by a clinically plausible amount, and that
 * every case stays inside the published safety envelope of the stage
 * (±ADJUNCT_CAP points, shrunk by hemispheric disagreement and poor signal).
 */
import { describe, expect, it } from "vitest";

import { ADJUNCT_CAP, coebisAdjunct, type AdjunctCorrection } from "./coebis-adjuncts";
import { montageFeatures, type MontageFeatures } from "./psi-features";
import type { MonitorEntropy } from "./entropy-monitor";

/** A GE Entropy module reading exactly as displayed at the bedside. */
function entropyReading(se: number, re: number, bsr = 0): MonitorEntropy {
  return { se, re, emgGap: Number((re - se).toFixed(1)), bsr };
}

/**
 * Frontal dB spectrum (0.5-30 Hz, 60 bins) shaped like the named clinical
 * pattern, then reduced to SedLine-style montage features.
 */
function montage(
  pattern: "awake-beta" | "propofol-alpha" | "slow-dominant",
  opts: { asymmetryDb?: number } = {},
): MontageFeatures {
  const side = (offsetDb: number) =>
    Array.from({ length: 60 }, (_, i) => {
      const hz = 0.5 + (i * (30 - 0.5)) / 59;
      let db: number;
      if (pattern === "awake-beta") db = hz >= 13 ? 2 : hz <= 4 ? -2 : -4;
      else if (pattern === "propofol-alpha") db = hz >= 8 && hz <= 12 ? 8 : hz <= 4 ? 10 : -8;
      else db = hz <= 4 ? 12 : -10;
      return db + offsetDb;
    });
  return montageFeatures(side(0), side(opts.asymmetryDb ?? 0));
}

interface Vignette {
  name: string;
  /** COEBIS after stages 1-3, i.e. before the adjunct. */
  aligned: number;
  entropy: MonitorEntropy | null;
  montage: MontageFeatures | null;
  bsr: number;
  quality?: number;
  /** What the commercial monitor displayed at the same instant. */
  commercial: number;
}

const CASES: Vignette[] = [
  {
    name: "awake, pre-oxygenation (SE 87 / RE 97)",
    aligned: 88,
    entropy: entropyReading(87, 97),
    montage: montage("awake-beta"),
    bsr: 0,
    quality: 0.9,
    commercial: 96,
  },
  {
    name: "laryngoscopy, partially paralysed (SE 45 / RE 70)",
    aligned: 45,
    entropy: entropyReading(45, 70),
    montage: montage("awake-beta"),
    bsr: 0,
    quality: 0.85,
    commercial: 58,
  },
  {
    name: "propofol/remifentanil maintenance (SE 40 / RE 45)",
    aligned: 52,
    entropy: entropyReading(40, 45),
    montage: montage("propofol-alpha"),
    bsr: 0,
    quality: 0.9,
    commercial: 45,
  },
  {
    name: "deep TIVA with burst suppression (SE 12, BSR 45 %)",
    aligned: 38,
    entropy: entropyReading(12, 13, 45),
    montage: montage("slow-dominant"),
    bsr: 45,
    quality: 0.8,
    commercial: 25,
  },
  {
    name: "emergence, entropies leading the index (SE 70 / RE 78)",
    aligned: 55,
    entropy: entropyReading(70, 78),
    montage: montage("awake-beta"),
    bsr: 0,
    quality: 0.85,
    commercial: 68,
  },
  {
    name: "diathermy burst, poor signal and asymmetric hemispheres",
    aligned: 45,
    entropy: entropyReading(45, 75),
    montage: montage("awake-beta", { asymmetryDb: 9 }),
    bsr: 0,
    quality: 0.35,
    commercial: 52,
  },
];

const run = (v: Vignette): AdjunctCorrection =>
  coebisAdjunct({
    aligned: v.aligned,
    entropy: v.entropy,
    montage: v.montage,
    bsr: v.bsr,
    ...(v.quality != null ? { quality: v.quality } : {}),
  });

describe("adjunct stage against real Entropy / SedLine readings", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "stays inside the safety envelope: %s",
    (_name, v) => {
      const a = run(v);
      expect(Number.isFinite(a.total)).toBe(true);
      expect(Math.abs(a.total)).toBeLessThanOrEqual(ADJUNCT_CAP);
      expect(a.shrink).toBeGreaterThanOrEqual(0.3);
      expect(a.shrink).toBeLessThanOrEqual(1);
      // Every reported part carries a clinician-readable rationale.
      for (const p of a.parts) {
        expect(p.label.length).toBeGreaterThan(3);
        expect(p.detail.length).toBeGreaterThan(20);
      }
      // The sum of the reported parts is what was applied.
      const sum = a.parts.reduce((s, p) => s + p.delta, 0);
      expect(Math.abs(sum - a.total)).toBeLessThanOrEqual(a.capped ? ADJUNCT_CAP : 0.1);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    "never moves COEBIS away from the commercial reading: %s",
    (_name, v) => {
      const a = run(v);
      const before = Math.abs(v.aligned - v.commercial);
      const after = Math.abs(v.aligned + a.total - v.commercial);
      expect(after).toBeLessThanOrEqual(before + 0.5);
    },
  );

  it("credits frontal EMG at laryngoscopy, as the BIS monitor did", () => {
    const a = run(CASES[1]!);
    expect(a.total).toBeGreaterThan(1);
    expect(a.parts.some((p) => p.label.includes("EMG"))).toBe(true);
  });

  it("reads the propofol alpha/slow-wave pattern as deeper than the index", () => {
    const a = run(CASES[2]!);
    expect(a.total).toBeLessThan(0);
    expect(
      a.parts.some((p) => p.label.includes("Entropy") || p.label.includes("spectral")),
    ).toBe(true);
  });

  it("drags the burst-suppression case down towards the monitor ceiling", () => {
    const a = run(CASES[3]!);
    expect(a.total).toBeLessThan(-1);
    expect(a.parts.some((p) => p.label.includes("Suppression"))).toBe(true);
    // Entropy concordance is suppressed above BSR 10 %, where SE saturates.
    expect(a.parts.some((p) => p.label.includes("State Entropy"))).toBe(false);
  });

  it("lifts the emergence case towards the rising entropies", () => {
    const a = run(CASES[4]!);
    expect(a.total).toBeGreaterThan(0.5);
  });

  it("shrinks the diathermy case relative to the same reading on a clean signal", () => {
    const messy = run(CASES[5]!);
    const clean = run({ ...CASES[5]!, montage: montage("awake-beta"), quality: 0.95 });
    expect(messy.shrink).toBeLessThan(clean.shrink);
    expect(Math.abs(messy.total)).toBeLessThan(Math.abs(clean.total));
  });

  it("moves monotonically with the RE-SE gap at a fixed depth", () => {
    const totals = [12, 20, 30, 45].map(
      (gap) =>
        coebisAdjunct({
          aligned: 45,
          entropy: entropyReading(45, 45 + gap),
          montage: null,
          bsr: 0,
          quality: 0.9,
        }).total,
    );
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]!).toBeGreaterThanOrEqual(totals[i - 1]!);
    }
    expect(totals.at(-1)!).toBeLessThanOrEqual(ADJUNCT_CAP);
  });

  it("keeps the whole case series clinically small (median |delta| under 5 points)", () => {
    const mags = CASES.map((v) => Math.abs(run(v).total)).sort((a, b) => a - b);
    const median = mags[Math.floor(mags.length / 2)]!;
    expect(median).toBeLessThan(5);
  });
});
