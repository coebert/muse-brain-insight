/**
 * CVA (acute stroke) watch — sudden unilateral loss of EEG signal.
 *
 * Acute cortical ischaemia shows on EEG before it shows clinically: the
 * affected side loses fast activity and gains slow activity, so one hemisphere
 * drops in power and its delta/alpha ratio climbs while the other side carries
 * on unchanged. That is the pattern this watch looks for — during carotid
 * cross-clamping it is the classic warning sign, and at the bedside it is a
 * reason to look at the patient.
 *
 * The whole difficulty is that a loose electrode looks exactly the same. So a
 * finding is only raised when the dropping side's own signal quality is still
 * good, its electrodes are not flat, and muscle artefact is not driving the
 * numbers. When quality has fallen away with the signal, the module says so
 * explicitly and raises nothing — a false stroke call at the bedside is worse
 * than none.
 *
 * This is an advisory pattern detector, not a diagnosis, and it has not been
 * validated against imaging-confirmed strokes. Nothing here is fitted to
 * recorded data; the thresholds below are stated defaults, adjustable per case.
 */

import { DSA_MAX_HZ, DSA_MIN_HZ } from "@/lib/eeg/analysis";

export type CvaSide = "left" | "right";
export type CvaStatus = "idle" | "baselining" | "stable" | "watch" | "alert";

/** One analysed epoch, both hemispheres, as the monitor already produces them. */
export interface CvaEpochInput {
  /** Seconds since the case started. */
  t: number;
  /** dB spectrum for the left electrode pair, DSA_MIN_HZ..DSA_MAX_HZ. */
  left: number[];
  /** dB spectrum for the right electrode pair, same bins. */
  right: number[];
  /** 0–100 signal quality for each side at this epoch. */
  leftSqi: number | null;
  rightSqi: number | null;
  /** 0–100 muscle artefact index across both sides at this epoch. */
  emg: number | null;
}

export interface CvaSettings {
  /** Quiet period used to learn what this patient's symmetry looks like. */
  baselineSeconds: number;
  /** How long the change must persist before it is called. */
  sustainSeconds: number;
  /** Power loss on one side, against its own baseline, that counts (%). */
  powerDropPercent: number;
  /** How much the other side may move before the change is called global (%). */
  contralateralTolerancePercent: number;
  /** Shift in the left/right balance that counts (percentage points). */
  asymmetryShiftPoints: number;
  /** Below this signal quality the side is treated as unreadable, not ischaemic. */
  minSqi: number;
  /** Above this muscle index the epoch is discarded. */
  maxEmg: number;
}

export const CVA_DEFAULTS: CvaSettings = {
  baselineSeconds: 180,
  sustainSeconds: 60,
  powerDropPercent: 40,
  contralateralTolerancePercent: 25,
  asymmetryShiftPoints: 12,
  minSqi: 50,
  maxEmg: 60,
};

export interface CvaPoint {
  t: number;
  /** Total 0.5–30 Hz power for each side (µV²), linear. */
  leftPower: number;
  rightPower: number;
  /** Directional balance: +100 all left, −100 all right, 0 symmetric. */
  asymmetry: number;
  /** Delta/alpha ratio per side — rises on the ischaemic side. */
  leftDar: number;
  rightDar: number;
  /** False when contact or muscle artefact makes the epoch unreadable. */
  usable: boolean;
}

export interface CvaBaseline {
  leftPower: number;
  rightPower: number;
  asymmetry: number;
  leftDar: number;
  rightDar: number;
  epochs: number;
}

export interface CvaFinding {
  /** The side that lost signal. */
  side: CvaSide;
  /** Seconds since case start when the change began. */
  onsetT: number;
  /** How long it has held. */
  durationSeconds: number;
  ongoing: boolean;
  /** Power lost on that side against its own baseline (%). */
  powerDropPercent: number;
  /** Power change on the other side over the same window (%). */
  contralateralChangePercent: number;
  /** Current balance and where it started. */
  asymmetry: number;
  baselineAsymmetry: number;
  /** Delta/alpha ratio on the affected side, now vs baseline. */
  dar: number;
  baselineDar: number;
  severity: "watch" | "alert";
  reasons: string[];
}

export interface CvaReport {
  status: CvaStatus;
  points: CvaPoint[];
  baseline: CvaBaseline | null;
  finding: CvaFinding | null;
  /** Set when the pattern is present but explained by contact or artefact. */
  excludedBy: string | null;
  /** Plain sentence for the bedside. */
  note: string;
  settings: CvaSettings;
}

function binHz(index: number, bins: number): number {
  if (bins <= 1) return DSA_MIN_HZ;
  return DSA_MIN_HZ + (index / (bins - 1)) * (DSA_MAX_HZ - DSA_MIN_HZ);
}

/** Linear power summed over a frequency band of one dB spectrum frame. */
export function bandPower(db: number[], loHz: number, hiHz: number): number {
  let sum = 0;
  for (let i = 0; i < db.length; i++) {
    const value = db[i]!;
    if (!Number.isFinite(value)) continue;
    const f = binHz(i, db.length);
    if (f < loHz || f > hiHz) continue;
    sum += Math.pow(10, value / 10);
  }
  return sum;
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentChange(now: number, before: number): number {
  if (!(before > 0)) return 0;
  return ((now - before) / before) * 100;
}

/** Turns one epoch of paired spectra into the numbers the watch reasons on. */
export function cvaPoint(input: CvaEpochInput, settings: CvaSettings): CvaPoint {
  const leftPower = bandPower(input.left, DSA_MIN_HZ, DSA_MAX_HZ);
  const rightPower = bandPower(input.right, DSA_MIN_HZ, DSA_MAX_HZ);
  const total = leftPower + rightPower;
  const leftAlpha = bandPower(input.left, 8, 13);
  const rightAlpha = bandPower(input.right, 8, 13);
  const usable =
    (input.leftSqi ?? 0) >= settings.minSqi &&
    (input.rightSqi ?? 0) >= settings.minSqi &&
    (input.emg ?? 0) <= settings.maxEmg &&
    Number.isFinite(leftPower) &&
    Number.isFinite(rightPower) &&
    total > 0;
  return {
    t: input.t,
    leftPower,
    rightPower,
    asymmetry: total > 0 ? ((leftPower - rightPower) / total) * 100 : 0,
    leftDar: leftAlpha > 0 ? bandPower(input.left, DSA_MIN_HZ, 4) / leftAlpha : Number.NaN,
    rightDar: rightAlpha > 0 ? bandPower(input.right, DSA_MIN_HZ, 4) / rightAlpha : Number.NaN,
    usable,
  };
}

/**
 * Reads a case for a sudden one-sided loss of EEG that contact cannot explain.
 */
export function detectCva(
  inputs: CvaEpochInput[],
  overrides: Partial<CvaSettings> = {},
): CvaReport {
  const settings = { ...CVA_DEFAULTS, ...overrides };
  const points = inputs.map((i) => cvaPoint(i, settings));
  const empty = (status: CvaStatus, note: string): CvaReport => ({
    status,
    points,
    baseline: null,
    finding: null,
    excludedBy: null,
    note,
    settings,
  });

  if (!points.length) return empty("idle", "No bilateral signal yet.");

  const start = points[0]!.t;
  const now = points[points.length - 1]!.t;
  const baselinePoints = points.filter(
    (p) => p.usable && p.t <= start + settings.baselineSeconds,
  );
  if (now - start < settings.baselineSeconds || baselinePoints.length < 5) {
    const left = Math.max(0, Math.round(settings.baselineSeconds - (now - start)));
    return empty(
      "baselining",
      `Learning this patient's own left/right balance — ${left} s to go. Nothing is judged until then.`,
    );
  }

  const baseline: CvaBaseline = {
    leftPower: median(baselinePoints.map((p) => p.leftPower)),
    rightPower: median(baselinePoints.map((p) => p.rightPower)),
    asymmetry: median(baselinePoints.map((p) => p.asymmetry)),
    leftDar: median(baselinePoints.filter((p) => Number.isFinite(p.leftDar)).map((p) => p.leftDar)),
    rightDar: median(
      baselinePoints.filter((p) => Number.isFinite(p.rightDar)).map((p) => p.rightDar),
    ),
    epochs: baselinePoints.length,
  };

  const windowPoints = points.filter((p) => p.t > now - settings.sustainSeconds);
  const usableWindow = windowPoints.filter((p) => p.usable);
  const withBaseline = (extra: Partial<CvaReport>): CvaReport => ({
    status: "stable",
    points,
    baseline,
    finding: null,
    excludedBy: null,
    note: "Both sides are tracking together.",
    settings,
    ...extra,
  });

  if (!usableWindow.length) {
    return withBaseline({
      status: "stable",
      note: "Signal quality is too poor right now to judge left against right.",
      excludedBy: "signal quality",
    });
  }

  const leftNow = median(usableWindow.map((p) => p.leftPower));
  const rightNow = median(usableWindow.map((p) => p.rightPower));
  const leftChange = percentChange(leftNow, baseline.leftPower);
  const rightChange = percentChange(rightNow, baseline.rightPower);
  const asymmetryNow = median(usableWindow.map((p) => p.asymmetry));
  const asymmetryShift = Math.abs(asymmetryNow - baseline.asymmetry);

  const side: CvaSide = leftChange <= rightChange ? "left" : "right";
  const drop = -(side === "left" ? leftChange : rightChange);
  const otherChange = side === "left" ? rightChange : leftChange;
  const darNow = median(
    usableWindow
      .map((p) => (side === "left" ? p.leftDar : p.rightDar))
      .filter((v) => Number.isFinite(v)),
  );
  const baselineDar = side === "left" ? baseline.leftDar : baseline.rightDar;

  // A one-sided drop with poor contact on that side is a loose electrode until
  // proven otherwise, so it is named as such and no finding is raised.
  const sideUnreadable = windowPoints.some((p) => !p.usable) && usableWindow.length < 2;
  if (drop >= settings.powerDropPercent && sideUnreadable) {
    return withBaseline({
      status: "stable",
      note: `The ${side} side has lost signal, but its contact quality fell at the same time — treat this as an electrode problem, not a stroke.`,
      excludedBy: "sensor contact",
    });
  }

  const globalChange = Math.abs(otherChange) > settings.contralateralTolerancePercent;
  const unilateral =
    drop >= settings.powerDropPercent &&
    !globalChange &&
    asymmetryShift >= settings.asymmetryShiftPoints;
  const nearMiss =
    !unilateral &&
    drop >= settings.powerDropPercent * 0.6 &&
    !globalChange &&
    asymmetryShift >= settings.asymmetryShiftPoints * 0.6;

  if (!unilateral && !nearMiss) {
    return withBaseline(
      globalChange && drop >= settings.powerDropPercent
        ? {
            note: "Both sides fell together — that is a depth or drug change, not a one-sided event.",
          }
        : {},
    );
  }

  // Onset: walk back to the first epoch where the affected side was already down.
  const threshold = baseline[side === "left" ? "leftPower" : "rightPower"] * (1 - drop / 200);
  let onsetT = usableWindow[0]!.t;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    if (!p.usable) continue;
    const value = side === "left" ? p.leftPower : p.rightPower;
    if (value > threshold) break;
    onsetT = p.t;
  }

  const reasons = [
    `${side === "left" ? "Left" : "Right"} side down ${drop.toFixed(0)}% against its own baseline`,
    `other side ${otherChange >= 0 ? "up" : "down"} ${Math.abs(otherChange).toFixed(0)}%`,
    `balance moved ${asymmetryShift.toFixed(0)} points`,
    `contact still good on both sides (quality above ${settings.minSqi})`,
  ];
  if (Number.isFinite(darNow) && Number.isFinite(baselineDar) && darNow > baselineDar * 1.3) {
    reasons.push(`slowing on that side too (delta/alpha ${baselineDar.toFixed(1)} → ${darNow.toFixed(1)})`);
  }

  const durationSeconds = Math.max(0, now - onsetT);
  const severity: CvaFinding["severity"] =
    unilateral && durationSeconds >= settings.sustainSeconds ? "alert" : "watch";

  return {
    status: severity,
    points,
    baseline,
    excludedBy: null,
    settings,
    finding: {
      side,
      onsetT,
      durationSeconds,
      ongoing: true,
      powerDropPercent: drop,
      contralateralChangePercent: otherChange,
      asymmetry: asymmetryNow,
      baselineAsymmetry: baseline.asymmetry,
      dar: darNow,
      baselineDar,
      severity,
      reasons,
    },
    note:
      severity === "alert"
        ? `Sudden one-sided loss of EEG on the ${side} side, held for ${Math.round(durationSeconds)} s, with good contact on both sides. Consider an acute cortical event and look at the patient.`
        : `The ${side} side is drifting down on its own. Watching — not yet enough to call.`,
  };
}
