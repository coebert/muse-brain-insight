/**
 * Stream test.
 *
 * Pairing proves a Bluetooth link exists; it does not prove the headband is
 * delivering something the analysis can use. The stream test closes that gap
 * in one tap: a few seconds of the live stream are captured, cut into
 * one-second epochs, and pushed through exactly the spectral path the monitor
 * uses. What comes back is the spectral array the clinician will see during
 * the case, computed from real packets, plus the handful of pass/fail checks
 * that decide whether the recording is worth starting:
 *
 *   * packets arrived and decoded into samples,
 *   * the delivered rate matches the rate discovery measured,
 *   * the spectrum is EEG-shaped — power concentrated below ~30 Hz with a
 *     roughly 1/f decline — rather than flat noise, a railed electrode or
 *     pure mains hum,
 *   * the amplitude is inside a physiological range.
 *
 * All of this is pure: the caller supplies the captured signal, so the same
 * function backs both the live panel and the tests.
 */

import { ANALYSIS_SAMPLE_RATE } from "@/lib/eeg/device-profile";
import { bandPower, computePsd, spectralEdge, type Psd } from "@/lib/eeg/dsp";

/** Frequency window shown by the mini spectral array, Hz. */
export const STREAM_TEST_MIN_HZ = 1;
export const STREAM_TEST_MAX_HZ = 30;

export interface StreamTestCheck {
  id: "packets" | "rate" | "spectrum" | "amplitude";
  label: string;
  ok: boolean;
  detail: string;
}

export interface StreamTestBands {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
}

export interface StreamTestResult {
  /** One column per analysed second: dB power over the display band. */
  columns: number[][];
  /** Frequency of each row of a column, Hz. */
  freqs: number[];
  /** dB range the columns were normalised against, for the legend. */
  dbFloor: number;
  dbCeiling: number;
  /** Median spectral edge across the epochs, Hz. */
  sef95: number;
  /** Relative band powers, summing to 1. */
  bands: StreamTestBands;
  /** Robust peak-to-peak amplitude, µV. */
  amplitudeUv: number;
  /** Samples per second actually delivered over the capture. */
  deliveredRate: number;
  checks: StreamTestCheck[];
  /** True when every check passed. */
  passed: boolean;
  /** One-line verdict for the panel. */
  summary: string;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Robust amplitude: the 5th-to-95th percentile spread of the samples. */
function robustPeakToPeak(signal: Float64Array): number {
  const finite = Array.from(signal).filter((v) => Number.isFinite(v));
  if (finite.length < 8) return 0;
  finite.sort((a, b) => a - b);
  const lo = finite[Math.floor(finite.length * 0.05)]!;
  const hi = finite[Math.floor(finite.length * 0.95)]!;
  return hi - lo;
}

function displayColumn(psd: Psd): { column: number[]; freqs: number[] } {
  const column: number[] = [];
  const freqs: number[] = [];
  for (let k = 0; k < psd.freqs.length; k++) {
    const f = psd.freqs[k]!;
    if (f < STREAM_TEST_MIN_HZ) continue;
    if (f > STREAM_TEST_MAX_HZ) break;
    freqs.push(f);
    column.push(10 * Math.log10(Math.max(psd.power[k]!, 1e-6)));
  }
  return { column, freqs };
}

export interface StreamTestOptions {
  /** Analysis rate the samples were resampled onto. */
  sampleRate?: number;
  /** Rate the device is expected to deliver, before resampling. */
  expectedRate?: number;
  /** Wall-clock duration of the capture, seconds. */
  captureSeconds: number;
  /** Notifications received during the capture. */
  packets?: number;
}

/**
 * Turns a captured burst of the live stream into a spectral array plus the
 * checks that decide whether a case may start on this signal.
 */
export function analyseStreamTest(
  signal: Float64Array,
  options: StreamTestOptions,
): StreamTestResult {
  const fs = options.sampleRate ?? ANALYSIS_SAMPLE_RATE;
  const epoch = fs;
  const columns: number[][] = [];
  let freqs: number[] = [];
  const sefs: number[] = [];
  const banded = { delta: 0, theta: 0, alpha: 0, beta: 0 };

  for (let start = 0; start + epoch <= signal.length; start += epoch) {
    const seg = signal.subarray(start, start + epoch);
    if (!seg.every((v) => Number.isFinite(v))) continue;
    const psd = computePsd(Float64Array.from(seg), fs);
    const { column, freqs: f } = displayColumn(psd);
    if (!freqs.length) freqs = f;
    columns.push(column);
    sefs.push(spectralEdge(psd, 0.95));
    banded.delta += bandPower(psd, 1, 4);
    banded.theta += bandPower(psd, 4, 8);
    banded.alpha += bandPower(psd, 8, 13);
    banded.beta += bandPower(psd, 13, 30);
  }

  const totalBand = banded.delta + banded.theta + banded.alpha + banded.beta;
  const bands: StreamTestBands = totalBand
    ? {
        delta: banded.delta / totalBand,
        theta: banded.theta / totalBand,
        alpha: banded.alpha / totalBand,
        beta: banded.beta / totalBand,
      }
    : { delta: 0, theta: 0, alpha: 0, beta: 0 };

  const flat = columns.flat();
  const sorted = [...flat].sort((a, b) => a - b);
  const dbFloor = sorted.length ? sorted[Math.floor(sorted.length * 0.05)]! : -20;
  const dbCeiling = sorted.length ? sorted[Math.floor(sorted.length * 0.98)]! : 20;

  const amplitudeUv = robustPeakToPeak(signal);
  const deliveredRate = options.captureSeconds > 0 ? signal.length / options.captureSeconds : 0;
  const expected = options.expectedRate ?? fs;
  const rateRatio = expected > 0 ? deliveredRate / expected : 0;
  const sef95 = median(sefs);

  // EEG declines with frequency; flat or beta-dominant power over a whole
  // capture is electrode noise or EMG, not cortex.
  const lowFraction = bands.delta + bands.theta + bands.alpha;
  const spectrumOk = columns.length >= 2 && lowFraction >= 0.4 && sef95 > 2 && sef95 < 29.5;

  const checks: StreamTestCheck[] = [
    {
      id: "packets",
      label: "Packets received and decoded",
      ok: columns.length >= 2,
      detail: columns.length
        ? `${options.packets ?? 0} notifications decoded into ${signal.length.toLocaleString()} samples — ${columns.length} spectral columns computed`
        : "No decodable samples arrived during the test",
    },
    {
      id: "rate",
      label: "Delivered sample rate",
      ok: rateRatio >= 0.7 && rateRatio <= 1.4,
      detail: `${Math.round(deliveredRate)} Hz delivered against ${Math.round(expected)} Hz expected`,
    },
    {
      id: "spectrum",
      label: "Spectral array is EEG-shaped",
      ok: spectrumOk,
      detail: spectrumOk
        ? `Spectral edge ${sef95.toFixed(1)} Hz, ${Math.round(lowFraction * 100)}% of power below 13 Hz`
        : columns.length < 2
          ? "Not enough clean seconds to build a spectral array"
          : `Power is not EEG-shaped (edge ${sef95.toFixed(1)} Hz, ${Math.round(lowFraction * 100)}% below 13 Hz) — reseat the band and keep still`,
    },
    {
      id: "amplitude",
      label: "Amplitude is physiological",
      ok: amplitudeUv > 2 && amplitudeUv < 400,
      detail: `${amplitudeUv.toFixed(1)} µV peak-to-peak (5–95th percentile)`,
    },
  ];

  const passed = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  return {
    columns,
    freqs,
    dbFloor,
    dbCeiling,
    sef95,
    bands,
    amplitudeUv,
    deliveredRate,
    checks,
    passed,
    summary: passed
      ? `Live stream verified — ${columns.length} s of EEG-shaped spectra at ${Math.round(deliveredRate)} Hz.`
      : `Stream test failed: ${failed.map((c) => c.label.toLowerCase()).join(", ")}.`,
  };
}

/** Colour for one spectral cell, matching the monitor's DSA ramp. */
export function streamTestCellColor(db: number, floor: number, ceiling: number): string {
  const span = Math.max(ceiling - floor, 1);
  const t = Math.min(1, Math.max(0, (db - floor) / span));
  // Blue → cyan → green → amber → red, the conventional DSA ramp.
  const hue = 240 - 240 * t;
  const light = 18 + 42 * t;
  return `hsl(${hue.toFixed(0)} 85% ${light.toFixed(0)}%)`;
}
