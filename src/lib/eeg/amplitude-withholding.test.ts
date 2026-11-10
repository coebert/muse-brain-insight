/**
 * Regression tests for the research-integrity rule: on a band without a
 * microvolt scale every amplitude-dependent output is withheld (null, with a
 * reason) — never computed with an assumed 0 % suppression — while the
 * amplitude-invariant spectral features stay available.
 */
import { describe, expect, it } from "vitest";
import { EPOCH_SECONDS, EegAnalyzer, type Epoch } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";
import { DepthIndexEstimator, UNCALIBRATED_DEPTH_REASON } from "./depth";
import { CompositeIndexEstimator, COMPOSITE_WITHHELD_REASON } from "./composite";
import { monitorEntropy } from "./entropy-monitor";
import { publishedIndices } from "./published-indices";
import { epochPayload } from "./batch-integrity";
import { buildFeatureDigest } from "./features";
import { buildStoredDigest } from "./stored-digest";
import { epochsToCsv, debugSessionJson, suppressionToCsv } from "./debug-export";
import { deriveAlarmConditions } from "./alarm-conditions";
import { deriveClinical } from "./derivations";
import { computeUncertainty } from "./uncertainty";
import { buildCaptureBatch } from "./auto-capture";
import { replayRawEeg } from "./replay";
import { FOCUSCALM_PROFILE, REGUL8_PROFILE } from "./device-profile";
import {
  measuredSeizureScore,
  measuredSuppressionRatio,
  suppressedSecondsOrNull,
} from "./measured";

const FS = MUSE_SAMPLE_RATE;
const N = EPOCH_SECONDS * FS;

/** Deterministic broadband "EEG" (~±amp), so every spectral bin carries power. */
function noise(seed: number, amp = 20): Float64Array {
  let s = seed >>> 0 || 1;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    const u = s / 0xffffffff - 0.5;
    w[i] = amp * 2 * u + 0.6 * amp * Math.sin((2 * Math.PI * 10 * i) / FS);
  }
  return w;
}

function suppressed(amp = 2): Float64Array {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = amp * Math.sin((2 * Math.PI * 9 * i) / FS);
  return w;
}

function run(a: EegAnalyzer, from: number, count: number, make: (t: number) => Float64Array) {
  const out: Epoch[] = [];
  for (let t = from; t < from + count; t++) out.push(a.analyze(make(t), t));
  return out;
}

const PATIENT = {
  ageYears: "",
  sex: "",
  admissionDiagnosis: "",
  clinicalFeatures: [],
  context: "theatre",
  notes: "",
} as never;

const META = { deviceLabel: "test", sampleRate: FS, startedAt: null, dsaMinHz: 0.5, dsaMaxHz: 30 };

describe("OpenIBIS depth estimator", () => {
  it("calibrated: produces the index, COEBIS and a measured BSR", () => {
    const est = new DepthIndexEstimator();
    let r = est.update(noise(1), FS, { usable: true });
    for (let i = 2; i < 40; i++) r = est.update(noise(i), FS, { usable: true });
    expect(r.index).not.toBeNull();
    expect(r.coebis).not.toBeNull();
    expect(r.components.bsr).toBe(0);
    expect(r.components.bsrScore).not.toBeNull();
    expect(r.withheldReason ?? null).toBeNull();
  });

  it("uncalibrated: withholds index, COEBIS, BSR and entropy but keeps the log power ratios", () => {
    const est = new DepthIndexEstimator();
    est.setAmplitudeCalibrated(false);
    let r = est.update(noise(1), FS, { usable: true });
    for (let i = 2; i < 40; i++) r = est.update(noise(i), FS, { usable: true });
    expect(r.index).toBeNull();
    expect(r.raw).toBeNull();
    expect(r.coebis).toBeNull();
    expect(r.coebisRaw).toBeNull();
    expect(r.components.bsr).toBeNull();
    expect(r.components.bsrScore).toBeNull();
    expect(r.entropy).toBeNull();
    expect(r.state).toBe("unreliable");
    expect(r.withheldReason).toBe(UNCALIBRATED_DEPTH_REASON);
    // Scale-invariant: identical whether the trace is in µV or ×1000 device units.
    const scaled = new DepthIndexEstimator();
    scaled.setAmplitudeCalibrated(false);
    let s = scaled.update(noise(1, 20000), FS, { usable: true });
    for (let i = 2; i < 40; i++) s = scaled.update(noise(i, 20000), FS, { usable: true });
    expect(Number.isFinite(r.components.betaRatio)).toBe(true);
    expect(Number.isFinite(r.components.slowWave)).toBe(true);
    expect(s.components.betaRatio).toBeCloseTo(r.components.betaRatio, 6);
    expect(s.components.slowWave).toBeCloseTo(r.components.slowWave, 6);
  });

  it("drops the held COEBIS and BSR history when calibration is lost and regained", () => {
    const est = new DepthIndexEstimator();
    for (let i = 1; i < 40; i++) est.update(noise(i), FS, { usable: true });
    est.setAmplitudeCalibrated(false);
    const lost = est.update(noise(50), FS, { usable: true });
    expect(lost.index).toBeNull();
    expect(lost.coebis).toBeNull();
    est.setAmplitudeCalibrated(true);
    // First calibrated epoch after the switch: the BSR window holds this epoch
    // only (a suppressed one), so the ratio is 100 % rather than a blend with
    // history measured before the switch.
    const back = est.update(suppressed(), FS, { usable: true });
    expect(back.components.bsr).toBe(100);
  });
});

describe("composite and entropy branches", () => {
  it("composite withholds both indices when suppression is null and keeps components", () => {
    const c = new CompositeIndexEstimator();
    const input = {
      bands: { delta: 4, theta: 2, alpha: 3, beta: 1, gamma: 0.2 },
      ratios: { deltaAlpha: 1.3, betaAlpha: 0.3, thetaAlpha: 0.7 },
      entropy: { shannon: 0.7, se95: 0.6, state: 0.65, response: 0.7 },
      usable: true,
    };
    let calibrated = c.update({ ...input, suppressionRatio: 0 });
    for (let i = 0; i < 12; i++) calibrated = c.update({ ...input, suppressionRatio: 0 });
    expect(calibrated.cIndex).not.toBeNull();
    // Losing calibration: nothing smoothed under the old scale is held.
    const withheld = c.update({ ...input, suppressionRatio: null });
    expect(withheld.cIndex).toBeNull();
    expect(withheld.nIndex).toBeNull();
    expect(withheld.held).toBe(false);
    expect(withheld.components.bsr).toBeNull();
    expect(withheld.components.fastSlow).toBeGreaterThan(0);
    expect(withheld.withheldReason).toBe(COMPOSITE_WITHHELD_REASON);
    // And the first calibrated epoch afterwards does not resurface the old value.
    expect(c.update({ ...input, suppressionRatio: 0 }).cIndex).toBeNull();
  });

  it("monitor entropy SE/RE are withheld for unknown suppression, not scaled by 0 %", () => {
    const row = new Float64Array(95).fill(1);
    expect(monitorEntropy([row], null).se).toBeNull();
    expect(monitorEntropy([row], null).bsr).toBeNull();
    expect(monitorEntropy([row], 0).se).not.toBeNull();
  });

  it("published indices keep the beta ratio but withhold SE/RE without suppression", () => {
    const spectrum = Array.from({ length: 60 }, (_, i) => 10 - i * 0.1);
    const out = publishedIndices(spectrum, 0.5, 0.5, null);
    expect(out.stateEntropy).toBeNull();
    expect(out.responseEntropy).toBeNull();
    expect(out.betaRatio).not.toBeNull();
  });
});

describe("EegAnalyzer amplitude calibration", () => {
  it("calibrated: suppression, seizure score and composite are measured", () => {
    const a = new EegAnalyzer();
    const epochs = run(a, 0, 30, (t) => noise(t + 1));
    const last = epochs[epochs.length - 1]!;
    expect(last.suppressionAvailable).toBe(true);
    expect(last.seizureAvailable).toBe(true);
    expect(last.amplitudeCalibrated).toBe(true);
    expect(measuredSuppressionRatio(last)).toBe(0);
    expect(measuredSeizureScore(last)).not.toBeNull();
    expect(last.composite.withheldReason ?? null).toBeNull();
  });

  it("uncalibrated: withholds amplitude-dependent outputs, keeps spectral entropy and SEF", () => {
    const a = new EegAnalyzer();
    a.setAmplitudeCalibrated(false);
    const epochs = run(a, 0, 30, (t) => noise(t + 1));
    const last = epochs[epochs.length - 1]!;
    expect(last.suppressionAvailable).toBe(false);
    expect(last.seizureAvailable).toBe(false);
    expect(last.amplitudeCalibrated).toBe(false);
    expect(measuredSuppressionRatio(last)).toBeNull();
    expect(measuredSeizureScore(last)).toBeNull();
    expect(last.seizureAlert).toBe(false);
    expect(last.depth.index).toBeNull();
    expect(last.depth.coebis).toBeNull();
    expect(last.composite.cIndex).toBeNull();
    expect(last.composite.nIndex).toBeNull();
    expect(last.depthReliability.reliable).toBe(false);
    expect(last.depthReliability.reasons).toContain(UNCALIBRATED_DEPTH_REASON);
    expect(last.confidence.seizure).toBe(0);
    // Amplitude-invariant features survive.
    expect(Number.isFinite(last.entropy.state)).toBe(true);
    expect(last.entropy.state).toBeGreaterThan(0);
    expect(last.sef95).toBeGreaterThan(0);
    expect(Number.isFinite(last.depth.components.betaRatio)).toBe(true);
  });

  it("does not apply the 500 µV artefact ceiling to device units", () => {
    // 300-unit 1 Hz sine: 600 peak-to-peak, below the clip and jump limits.
    const big = () => {
      const w = new Float64Array(N);
      for (let i = 0; i < N; i++) w[i] = 300 * Math.sin((2 * Math.PI * 1 * i) / FS);
      return w;
    };
    const cal = new EegAnalyzer();
    expect(cal.analyze(big(), 0).artifact).toBe(true);
    const uncal = new EegAnalyzer();
    uncal.setAmplitudeCalibrated(false);
    expect(uncal.analyze(big(), 0).artifact).toBe(false);
  });

  it("switching calibrated → uncalibrated leaves no stale score; switching back restarts", () => {
    const a = new EegAnalyzer();
    const before = run(a, 0, 40, () => suppressed());
    expect(measuredSuppressionRatio(before[before.length - 1])).toBeGreaterThan(90);
    a.setAmplitudeCalibrated(false);
    const during = a.analyze(noise(7), 40);
    expect(measuredSuppressionRatio(during)).toBeNull();
    expect(during.depth.index).toBeNull();
    expect(during.depth.coebis).toBeNull();
    expect(during.composite.cIndex).toBeNull();
    expect(during.composite.held).toBe(false);
    a.setAmplitudeCalibrated(true);
    // First calibrated epoch afterwards: SR comes only from this (active) epoch,
    // not the 90 %+ history measured before the switch.
    const after = a.analyze(noise(8), 41);
    expect(measuredSuppressionRatio(after)).toBe(0);
  });
});

describe("persistence, export, digest and display missingness", () => {
  function uncalibratedEpochs(): Epoch[] {
    const a = new EegAnalyzer();
    a.setAmplitudeCalibrated(false);
    return run(a, 0, 30, (t) => noise(t + 1));
  }

  it("stored rows carry NULL for every withheld value and keep relative components", () => {
    const row = epochPayload(uncalibratedEpochs().at(-1)!);
    expect(row.suppression_ratio).toBeNull();
    expect(row.is_suppressed).toBeNull();
    expect(row.seizure_score).toBeNull();
    expect(row.depth_index).toBeNull();
    expect(row.consciousness_index).toBeNull();
    expect(row.nociception_index).toBeNull();
    expect(row.depth_components["bsr"]).toBeNull();
    expect(row.composite_components["bsr"]).toBeNull();
    expect(row.depth_components["c1"]).not.toBeNull();
    expect(row.composite_components["fast_slow"]).not.toBeNull();
  });

  it("calibrated rows still store measured values", () => {
    const a = new EegAnalyzer();
    const row = epochPayload(run(a, 0, 30, (t) => noise(t + 1)).at(-1)!);
    expect(row.suppression_ratio).toBe(0);
    expect(typeof row.seizure_score).toBe("number");
    expect(row.depth_components["bsr"]).toBe(0);
  });

  it("debug exports leave withheld fields blank / null", () => {
    const epochs = uncalibratedEpochs();
    const json = JSON.parse(debugSessionJson(epochs, META));
    const frame = json.frames.at(-1);
    expect(frame.seizureScore).toBeNull();
    expect(frame.seizureAlert).toBeNull();
    expect(frame.suppressionRatio).toBeNull();
    expect(frame.amplitudeUv).toBeNull();
    expect(frame.amplitudeDeviceUnits).toBeGreaterThan(0);
    expect(frame.depth).toBeNull();
    expect(frame.depthWithheldReason).toBe(UNCALIBRATED_DEPTH_REASON);
    const csv = epochsToCsv(epochs, META).trim().split("\n");
    const header = csv.find((l) => l.startsWith("t_seconds"))!.split(",");
    const cells = csv.at(-1)!.split(",");
    expect(cells[header.indexOf("seizure_score")]).toBe("");
    expect(cells[header.indexOf("suppression_ratio_pct")] ?? "").toBe("");
    const supp = suppressionToCsv(epochs).trim().split("\n").at(-1)!.split(",");
    expect(supp[3]).toBe("");
    expect(supp[4]).toBe("");
  });

  it("the background capture stores no µV amplitude for device units", () => {
    const batch = buildCaptureBatch(uncalibratedEpochs(), {
      afterSeconds: -1,
      sessionStartMs: 0,
    } as never);
    const row = batch.epochs.at(-1)!;
    expect(row.amplitudeUv).toBeNull();
    expect(row.suppressionRatio).toBeNull();
    expect(row.depthIndex).toBeNull();
  });

  it("the live AI digest marks every amplitude-dependent block unavailable", () => {
    const epochs = uncalibratedEpochs();
    const d = buildFeatureDigest(epochs, [], PATIENT, 30, "anaesthesia");
    expect(d.suppression.available).toBe(false);
    expect(d.seizure.available).toBe(false);
    expect(d.seizure.meanScore).toBeNull();
    expect(d.seizure.alerts).toBeNull();
    expect(d.depthIndex.available).toBe(false);
    expect(d.depthIndex.unavailableReason).toBe(UNCALIBRATED_DEPTH_REASON);
    expect(d.depthIndex.fractionBelow40WhenReliable).toBeNull();
    expect(d.compositeIndex.available).toBe(false);
    expect(d.compositeIndex.fractionNociceptionAbove60).toBeNull();
    expect(d.timeline.every((p) => p.srPct === null && p.seizureScore === null)).toBe(true);
    expect(d.spectral.meanStateEntropy).toBeGreaterThan(0);
  });

  it("the stored-case digest treats all-NULL seizure scores as withheld", () => {
    const rows = [0, 1, 2].map((t) => ({
      t,
      depth: null,
      sef95: 12,
      sr: null,
      seizure: null,
      cIndex: null,
      nIndex: null,
      entropy: 60,
      suppressed: null,
    }));
    const d = buildStoredDigest(rows, [], {
      caseCode: "T",
      context: "theatre",
      ageBand: null,
      sex: null,
      admissionDiagnosis: null,
      clinicalFeatures: [],
      notes: null,
      durationSeconds: 3,
    });
    expect(d.seizure.available).toBe(false);
    expect(d.seizure.fractionAboveHalf).toBeNull();
    expect(d.suppression.suppressedSeconds).toBeNull();
    expect(d.depthIndex.fractionBelow40).toBeNull();
    expect(suppressedSecondsOrNull(rows, 1)).toBeNull();
    expect(suppressedSecondsOrNull([{ suppressed: 1 }, { suppressed: 0 }], 1)).toBe(1);
  });

  it("live values, alarms and uncertainty never show withheld values as 0", () => {
    const epochs = uncalibratedEpochs();
    const derived = deriveClinical({
      epochs,
      events: [],
      markers: [],
      hemi: null,
      settings: { srWindowSeconds: 60, seizureThreshold: 0.6, bsrAlertPercent: 0 },
      icuMode: true,
      dataGapSeconds: 0,
      reconnecting: false,
    });
    expect(derived.live.suppressionRatio).toBeNull();
    expect(derived.live.seizureScore).toBeNull();
    expect(derived.live.depthIndex).toBeNull();
    expect(derived.srTone).toBe("default");
    // bsrAlertPercent 0 would fire on any measured value — a withheld one must not.
    const alarms = deriveAlarmConditions({
      latest: epochs.at(-1)!,
      hemi: null,
      icuMode: true,
      bsrAlertPercent: 0,
      dataGapSeconds: 0,
      reconnecting: false,
    });
    expect(alarms.some((c) => c.id.includes("suppression"))).toBe(false);
    const u = computeUncertainty(epochs, { srWindowSeconds: 60, seizureThreshold: 0.6 });
    expect(u.suppression.value).toBeNull();
    expect(u.seizure.value).toBeNull();
  });

  it("offline replay of a non-microvolt file withholds suppression and the index", () => {
    const samples = new Float64Array(FS * 40);
    for (let i = 0; i < samples.length; i++) samples[i] = noise(i % 97 + 1)[i % N]!;
    const r = replayRawEeg({ samples, sampleRate: FS, amplitudeCalibrated: false });
    expect(r.frames.length).toBeGreaterThan(0);
    expect(r.frames.every((f) => f.suppressionRatio === null && f.appIndex === null)).toBe(true);
    expect(r.frames.every((f) => f.coebis === null)).toBe(true);
  });

  it("FocusCalm and Regul8 notes say amplitude-dependent outputs are withheld", () => {
    for (const p of [FOCUSCALM_PROFILE, REGUL8_PROFILE]) {
      expect(p.calibratedAmplitude).toBe(false);
      expect(p.note).toMatch(/withheld/);
      expect(p.note).not.toMatch(/[Ss]uppression (ratio|fraction)[^.]*(remain|stay) interpretable/);
    }
  });
});
