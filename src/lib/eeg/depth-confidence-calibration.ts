/**
 * Calibration of the depth-index confidence cut-offs.
 *
 * The app grades a depth reading "unreliable" below a confidence of 0.35 and
 * "degraded" below 0.6. Those two numbers were picked by hand and have never
 * been checked against reality. The check is simple: for readings taken at each
 * confidence level, how often did the index actually agree with the reference
 * monitor? A cut-off is honest when it separates readings that agreed from
 * readings that did not.
 *
 * Agreement is |app − reference| within a tolerance, 10 index points by
 * default, the conventional band inside which two depth monitors are treated as
 * saying the same thing.
 */

export const CURRENT_UNRELIABLE_BELOW = 0.35;
export const CURRENT_DEGRADED_BELOW = 0.6;

/** Hit rate a "degraded but usable" and a fully "reliable" reading should reach. */
export const DEGRADED_TARGET = 0.6;
export const RELIABLE_TARGET = 0.8;

export interface ConfidenceSample {
  /** Stated depth confidence at the moment of the reading, 0–1. */
  confidence: number;
  /** Absolute difference between the app index and the reference. */
  absError: number;
}

export interface ConfidenceBin {
  label: string;
  lower: number;
  upper: number;
  n: number;
  agreed: number;
  /** Observed share within tolerance, 0–1. */
  rate: number | null;
}

export interface CutoffCheck {
  cut: number;
  n: number;
  /** Observed agreement for readings at or above the cut. */
  rateAtOrAbove: number | null;
  /** Observed agreement for readings below the cut. */
  rateBelow: number | null;
  nBelow: number;
}

export interface ConfidenceCalibration {
  n: number;
  tolerance: number;
  bins: ConfidenceBin[];
  current: { unreliableBelow: CutoffCheck; degradedBelow: CutoffCheck };
  /** Where the data puts the cut-offs, or null when the data cannot say. */
  recommended: { unreliableBelow: number | null; degradedBelow: number | null };
  /** Does agreement actually rise with stated confidence? */
  discriminates: boolean;
  summary: string;
}

const BIN_EDGES = [0, 0.2, 0.35, 0.5, 0.6, 0.75, 1.0001];

const rate = (agreed: number, n: number) => (n ? Number((agreed / n).toFixed(3)) : null);

function check(samples: ConfidenceSample[], cut: number, tolerance: number): CutoffCheck {
  const above = samples.filter((s) => s.confidence >= cut);
  const below = samples.filter((s) => s.confidence < cut);
  return {
    cut: Number(cut.toFixed(2)),
    n: above.length,
    rateAtOrAbove: rate(above.filter((s) => s.absError <= tolerance).length, above.length),
    rateBelow: rate(below.filter((s) => s.absError <= tolerance).length, below.length),
    nBelow: below.length,
  };
}

/**
 * Lowest cut-off on a 0.05 grid at which readings at or above it reach the
 * target hit rate, with enough readings above it to mean something.
 */
function lowestCutMeeting(
  samples: ConfidenceSample[],
  target: number,
  tolerance: number,
  minN: number,
): number | null {
  for (let cut = 0; cut <= 0.9; cut += 0.05) {
    const above = samples.filter((s) => s.confidence >= cut);
    if (above.length < minN) continue;
    const hit = above.filter((s) => s.absError <= tolerance).length / above.length;
    if (hit >= target) return Number(cut.toFixed(2));
  }
  return null;
}

export function calibrateDepthConfidence(
  samples: ConfidenceSample[],
  tolerance = 10,
): ConfidenceCalibration {
  const usable = samples.filter(
    (s) => Number.isFinite(s.confidence) && Number.isFinite(s.absError) && s.confidence >= 0,
  );
  const bins: ConfidenceBin[] = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    const lower = BIN_EDGES[i]!;
    const upper = BIN_EDGES[i + 1]!;
    const inBin = usable.filter((s) => s.confidence >= lower && s.confidence < upper);
    bins.push({
      label: `${Math.round(lower * 100)}–${Math.round(Math.min(1, upper) * 100)} %`,
      lower,
      upper: Math.min(1, upper),
      n: inBin.length,
      agreed: inBin.filter((s) => s.absError <= tolerance).length,
      rate: rate(inBin.filter((s) => s.absError <= tolerance).length, inBin.length),
    });
  }

  const current = {
    unreliableBelow: check(usable, CURRENT_UNRELIABLE_BELOW, tolerance),
    degradedBelow: check(usable, CURRENT_DEGRADED_BELOW, tolerance),
  };

  const minN = Math.max(8, Math.round(usable.length * 0.1));
  const recommended =
    usable.length >= 20
      ? {
          unreliableBelow: lowestCutMeeting(usable, DEGRADED_TARGET, tolerance, minN),
          degradedBelow: lowestCutMeeting(usable, RELIABLE_TARGET, tolerance, minN),
        }
      : { unreliableBelow: null, degradedBelow: null };

  // Does the stated confidence carry information at all? Compare the readings
  // the app called reliable with the ones it did not.
  const high = usable.filter((s) => s.confidence >= CURRENT_DEGRADED_BELOW);
  const low = usable.filter((s) => s.confidence < CURRENT_UNRELIABLE_BELOW);
  const highRate = rate(high.filter((s) => s.absError <= tolerance).length, high.length);
  const lowRate = rate(low.filter((s) => s.absError <= tolerance).length, low.length);
  const discriminates =
    high.length >= 5 && low.length >= 5 && highRate != null && lowRate != null
      ? highRate - lowRate >= 0.1
      : false;

  let summary: string;
  if (usable.length < 20) {
    summary = `Only ${usable.length} reading${usable.length === 1 ? "" : "s"} carry a recorded depth confidence, which is too few to move the cut-offs. They are still at their hand-picked values of ${CURRENT_UNRELIABLE_BELOW} and ${CURRENT_DEGRADED_BELOW}.`;
  } else {
    const parts: string[] = [];
    if (current.degradedBelow.rateAtOrAbove != null) {
      parts.push(
        `Readings the app called reliable landed within ${tolerance} points of the monitor ${Math.round(current.degradedBelow.rateAtOrAbove * 100)} % of the time`,
      );
    }
    if (current.unreliableBelow.rateBelow != null) {
      parts.push(
        `readings it called unreliable did so ${Math.round(current.unreliableBelow.rateBelow * 100)} % of the time`,
      );
    }
    const move: string[] = [];
    if (
      recommended.unreliableBelow != null &&
      Math.abs(recommended.unreliableBelow - CURRENT_UNRELIABLE_BELOW) >= 0.05
    ) {
      move.push(`the unreliable line to ${recommended.unreliableBelow.toFixed(2)}`);
    }
    if (
      recommended.degradedBelow != null &&
      Math.abs(recommended.degradedBelow - CURRENT_DEGRADED_BELOW) >= 0.05
    ) {
      move.push(`the reliable line to ${recommended.degradedBelow.toFixed(2)}`);
    }
    summary = `${parts.join(", and ")}. ${
      !discriminates
        ? "The stated confidence is not yet separating good readings from bad ones, so treat the grading as provisional."
        : move.length
          ? `The data would put ${move.join(" and ")}.`
          : "The hand-picked cut-offs sit where the data puts them."
    }`;
  }

  return {
    n: usable.length,
    tolerance,
    bins,
    current,
    recommended,
    discriminates,
    summary,
  };
}
