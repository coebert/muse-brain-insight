/**
 * DOSE-I raw recordings: MOAA/S-referenced depth.
 *
 * The Zenodo record's `data.zip` publishes one CSV per procedure holding the
 * two raw frontal EEG channels from a Philips IntelliVue monitor (EEG_1 =
 * Fp2–Fp1, EEG_2 = Fz–F7) sampled around 125 Hz, interleaved with the other
 * bedside waveforms and with the clinical annotations — including the
 * contemporaneous MOAA/S sedation score.
 *
 * DOSE-I publishes no bedside depth index. What it publishes is a *validated
 * clinical sedation score*, and this module turns that score into a coarse
 * depth reference so the recording can contribute to a fit. The same honesty
 * rules the ds004541 event-state route enforces apply here, plus one more:
 *
 *  1. Only stable stretches are used. A window is dropped when the score
 *     changed recently — during a transition the depth is moving and any
 *     single reference value would be wrong for most of the interval.
 *  2. A guard band is dropped at each end of a stable run.
 *  3. The reference is labelled `moaas-score`, carries a wide uncertainty and
 *     never claims to be a commercial monitor reading. It belongs to its own
 *     acquisition lineage and cannot reach a device-specific COEBIS fit.
 *  4. MOAA/S is an ordinal *responsiveness* scale, not an index. The anchors
 *     below are a clinical mapping onto the 0–100 scale, deliberately given a
 *     spread wide enough to cover the published BIS-vs-MOAA/S overlap, so a
 *     fit weights them well below a real paired monitor reading.
 */

import type { ReplayFrame } from "./replay";
import { lineageKey, type DataLineage } from "./model-lineage";

export const DOSE1_DEPTH_REFERENCE_KIND = "moaas-score";
/** Device id the DOSE-I bedside frontal montage is filed under. */
export const DOSE1_DEPTH_DEVICE_ID = "dose-i-intellivue";
export const DOSE1_DEPTH_SOURCE = "zenodo-dose-i";

/**
 * MOAA/S level → reference index on the BIS/COEBIS 0–100 scale.
 *
 * 5 is a fully alert response to name spoken in a normal tone; 0 is no
 * response to a painful trapezius squeeze. The anchors walk the conventional
 * clinical range — alert in the low nineties down to general-anaesthetic depth
 * at 0 — and the sigmas widen as the scale coarsens, because a single MOAA/S
 * level spans a broad band of measured index values in the sedation
 * literature.
 */
export const MOAAS_DEPTH_ANCHORS: Record<number, { depth: number; sigma: number }> = {
  5: { depth: 93, sigma: 6 },
  4: { depth: 84, sigma: 9 },
  3: { depth: 76, sigma: 11 },
  2: { depth: 68, sigma: 12 },
  1: { depth: 60, sigma: 13 },
  0: { depth: 50, sigma: 15 },
};

export function moaasAnchor(score: number): { depth: number; sigma: number } | null {
  return MOAAS_DEPTH_ANCHORS[Math.round(score)] ?? null;
}

/** MOAA/S → this app's shared state vocabulary (same cuts as the pEEG route). */
export function moaasState(score: number): string {
  if (score >= 5) return "awake";
  if (score >= 3) return "sedated";
  return "anaesthetised";
}

export function dose1DepthLineage(sampleRate: number): DataLineage {
  return {
    deviceId: DOSE1_DEPTH_DEVICE_ID,
    deviceLabel: "DOSE-I IntelliVue frontal montage (Fp2–Fp1)",
    transport: "ingest",
    channels: ["AF8"],
    sampleRate: Math.round(sampleRate),
  };
}

export function dose1DepthLineageKey(sampleRate: number): string {
  return lineageKey(dose1DepthLineage(sampleRate));
}

/* ------------------------------------------------------------- parsing --- */

export interface Dose1Sample {
  /** Seconds from the first sample in the file. */
  t: number;
  uv: number;
}

export interface MoaasObservation {
  atSeconds: number;
  score: number;
}

export interface Dose1RawRecording {
  /** Uniformly resampled EEG_1, µV, at `sampleRate`. */
  samples: Float64Array;
  sampleRate: number;
  durationSeconds: number;
  /** Every MOAA/S annotation the file carries, in order. */
  observations: MoaasObservation[];
  /** Rows that carried no usable EEG sample. */
  skipped: number;
}

const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Seconds from a `YYYY-MM-DD HH:MM:SS.mmm` stamp, or null. */
export function dose1ClockSeconds(v: string | undefined): number | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  const ms = Date.parse(t.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(t) ? "" : "Z"));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export interface Dose1RawOptions {
  /** Which raw EEG column to replay. */
  channel?: "EEG_1" | "EEG_2";
  /** Rate the irregular samples are resampled onto; detected when omitted. */
  sampleRate?: number;
}

/**
 * Parse one DOSE-I raw case CSV.
 *
 * The file is a sparse union of every bedside stream, so a given row carries a
 * value for only some columns. EEG samples are taken where present, the median
 * inter-sample gap sets the rate, and the series is placed on a uniform grid by
 * nearest-sample hold — the openibis front end needs a fixed rate and the
 * jitter is well under one sample period.
 */
export function parseDose1RawCsv(text: string, options: Dose1RawOptions = {}): Dose1RawRecording {
  const wanted = options.channel ?? "EEG_1";
  const nl = text.indexOf("\n");
  if (nl < 0) throw new Error("The raw file is empty.");
  const header = text
    .slice(0, nl)
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""));

  const idxOf = (suffix: string) =>
    header.findIndex((h) => h === suffix || h.toLowerCase().endsWith(`/${suffix.toLowerCase()}`));
  const timeIdx = header.findIndex((h) => h.toLowerCase() === "time");
  const eegIdx = idxOf(wanted);
  const moaasIdx = header.findIndex((h) => h.trim().toUpperCase() === "MOAAS");
  if (timeIdx < 0) throw new Error("The raw file has no Time column.");
  if (eegIdx < 0) throw new Error(`The raw file has no ${wanted} column.`);

  const points: Dose1Sample[] = [];
  const observations: MoaasObservation[] = [];
  let skipped = 0;
  let t0: number | null = null;

  let cursor = nl + 1;
  while (cursor < text.length) {
    let end = text.indexOf("\n", cursor);
    if (end < 0) end = text.length;
    const line = text.slice(cursor, end);
    cursor = end + 1;
    if (!line.trim()) continue;
    const row = line.split(",");

    const clock = dose1ClockSeconds(row[timeIdx]);
    if (clock == null) {
      skipped++;
      continue;
    }
    if (t0 == null) t0 = clock;
    const t = clock - t0;

    const moaas = moaasIdx >= 0 ? num(row[moaasIdx]) : null;
    if (moaas != null && moaas >= 0 && moaas <= 5) {
      observations.push({ atSeconds: t, score: Math.round(moaas) });
    }

    const uv = num(row[eegIdx]);
    if (uv == null) {
      skipped++;
      continue;
    }
    points.push({ t, uv });
  }

  if (points.length < 8) {
    return {
      samples: new Float64Array(0),
      sampleRate: options.sampleRate ?? 0,
      durationSeconds: 0,
      observations,
      skipped,
    };
  }

  const fs = options.sampleRate ?? detectSampleRate(points);
  const duration = points[points.length - 1]!.t - points[0]!.t;
  const n = Math.max(0, Math.floor(duration * fs));
  const samples = new Float64Array(n);
  // Nearest-sample hold onto the uniform grid.
  let p = 0;
  const start = points[0]!.t;
  for (let i = 0; i < n; i++) {
    const want = start + i / fs;
    while (p + 1 < points.length && points[p + 1]!.t <= want) p++;
    samples[i] = points[p]!.uv;
  }

  return {
    samples,
    sampleRate: fs,
    durationSeconds: n / fs,
    observations,
    skipped,
  };
}

/** Median inter-sample interval → nominal rate, rounded to whole Hz. */
export function detectSampleRate(points: Dose1Sample[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length && gaps.length < 20_000; i++) {
    const d = points[i]!.t - points[i - 1]!.t;
    if (d > 0 && d < 1) gaps.push(d);
  }
  if (!gaps.length) return 125;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  const fs = Math.round(1 / median);
  return fs > 0 && fs <= 1000 ? fs : 125;
}

/**
 * Seconds where the amplifier sat on its rails.
 *
 * The DOSE-I export saturates hard at ±187.5 µV. A clipped window is not an
 * EEG measurement, so any reading computed from one is discarded rather than
 * fitted — the spectral front end cannot tell a flat rail from a real signal.
 */
export function clippedSeconds(
  samples: Float64Array,
  sampleRate: number,
  options: { railUv?: number; maxFraction?: number } = {},
): (atSeconds: number) => boolean {
  const rail = options.railUv ?? 187.5;
  const maxFraction = options.maxFraction ?? 0.01;
  const seconds = Math.floor(samples.length / sampleRate);
  const bad = new Set<number>();
  for (let s = 0; s < seconds; s++) {
    let hits = 0;
    const from = Math.floor(s * sampleRate);
    const to = Math.floor((s + 1) * sampleRate);
    for (let i = from; i < to; i++) if (Math.abs(samples[i]!) >= rail - 1e-6) hits++;
    if (hits / Math.max(1, to - from) > maxFraction) bad.add(s);
  }
  // A reading covers the trailing window, so reject a second when the window
  // behind it touched the rails too.
  return (t: number) => {
    const end = Math.floor(t);
    for (let s = Math.max(0, end - 3); s <= end; s++) if (bad.has(s)) return true;
    return false;
  };
}

/* -------------------------------------------------------------- states --- */

export interface MoaasInterval {
  startSeconds: number;
  stopSeconds: number;
  score: number;
}

/**
 * Turn the sparse MOAA/S observations into stable intervals.
 *
 * The score is carried forward until the next observation, and a run is only
 * kept while the score is unchanged. Consecutive identical observations are
 * merged; a change ends the run there and starts a new one.
 */
export function moaasIntervals(
  observations: MoaasObservation[],
  endSeconds: number,
): MoaasInterval[] {
  const sorted = [...observations].sort((a, b) => a.atSeconds - b.atSeconds);
  const runs: MoaasInterval[] = [];
  for (const o of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.score === o.score) continue;
    if (last) last.stopSeconds = o.atSeconds;
    runs.push({ startSeconds: o.atSeconds, stopSeconds: endSeconds, score: o.score });
  }
  const open = runs[runs.length - 1];
  if (open) open.stopSeconds = Math.max(open.startSeconds, endSeconds);
  return runs.filter((r) => r.stopSeconds > r.startSeconds);
}

export interface Dose1DepthOptions {
  /** One retained reading per this many seconds. */
  strideSeconds?: number;
  /** Seconds dropped at each end of a stable run while the score settles. */
  guardSeconds?: number;
  /** Runs shorter than this contribute nothing. */
  minIntervalSeconds?: number;
  /** Seconds where the amplifier was on its rails; those windows are dropped. */
  clipped?: (atSeconds: number) => boolean;
}

export interface Dose1DepthPoint {
  atSeconds: number;
  reference: number;
  referenceSigma: number;
  moaas: number;
  state: string;
  appIndex: number;
  appSef: number | null;
  appSr: number | null;
  reliable: boolean;
  externalRef: string;
}

export interface Dose1DepthResult {
  points: Dose1DepthPoint[];
  scores: Record<number, number>;
  rejected: {
    shortInterval: number;
    noIndex: number;
    guarded: number;
    noAnchor: number;
    clipped: number;
  };
}

/**
 * Pair replayed app indices with the MOAA/S level recorded at that second.
 */
export function buildMoaasDepthPoints(
  frames: ReplayFrame[],
  intervals: MoaasInterval[],
  meta: { caseRef: string; channel: string },
  options: Dose1DepthOptions = {},
): Dose1DepthResult {
  const stride = Math.max(1, options.strideSeconds ?? 10);
  const guard = Math.max(0, options.guardSeconds ?? 30);
  const minInterval = Math.max(guard * 2 + stride, options.minIntervalSeconds ?? 120);
  const rejected = { shortInterval: 0, noIndex: 0, guarded: 0, noAnchor: 0, clipped: 0 };
  const scores: Record<number, number> = {};
  const points: Dose1DepthPoint[] = [];

  const usable = intervals.filter((iv) => {
    if (!moaasAnchor(iv.score)) {
      rejected.noAnchor++;
      return false;
    }
    if (iv.stopSeconds - iv.startSeconds < minInterval) {
      rejected.shortInterval++;
      return false;
    }
    return true;
  });

  for (const iv of usable) {
    const anchor = moaasAnchor(iv.score)!;
    const from = iv.startSeconds + guard;
    const to = iv.stopSeconds - guard;
    let taken = -Infinity;
    for (const frame of frames) {
      if (frame.t < iv.startSeconds || frame.t > iv.stopSeconds) continue;
      if (frame.t < from || frame.t > to) {
        rejected.guarded++;
        continue;
      }
      if (frame.t - taken < stride) continue;
      if (frame.appIndex == null || !Number.isFinite(frame.appIndex)) {
        rejected.noIndex++;
        continue;
      }
      if (options.clipped?.(frame.t)) {
        rejected.clipped++;
        continue;
      }
      taken = frame.t;
      const at = Math.round(frame.t * 10) / 10;
      points.push({
        atSeconds: at,
        reference: anchor.depth,
        referenceSigma: anchor.sigma,
        moaas: iv.score,
        state: moaasState(iv.score),
        appIndex: Number(frame.appIndex.toFixed(1)),
        appSef: Number.isFinite(frame.sef95) ? Number(frame.sef95.toFixed(2)) : null,
        appSr: Number.isFinite(frame.suppressionRatio)
          ? Number(frame.suppressionRatio.toFixed(1))
          : null,
        reliable: true,
        externalRef: `${DOSE1_DEPTH_SOURCE}:${meta.caseRef}:${meta.channel}:${at.toFixed(1)}`,
      });
      scores[iv.score] = (scores[iv.score] ?? 0) + 1;
    }
  }

  points.sort((a, b) => a.atSeconds - b.atSeconds);
  return { points, scores, rejected };
}
