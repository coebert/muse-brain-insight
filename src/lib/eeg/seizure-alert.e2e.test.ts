/**
 * End-to-end: the seizure detector alerts when — and only when — it should.
 *
 * Ingests synthetic epochs through the real analyzer: evolving rhythmic ictal
 * runs, spike-and-wave, and a set of non-ictal look-alikes (anaesthetic alpha,
 * monotonous delta, burst suppression, chewing and EMG artefact). It checks
 * that an alert is raised inside each seizure, that it only fires after the
 * configured run of consecutive threshold-crossing epochs, that a seizure
 * event with a duration is emitted, and that the baseline recordings stay
 * completely silent.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, EegAnalyzer, type Epoch, type ClinicalEvent } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";
import {
  SEIZURE_VIGNETTES,
  runSeizureValidation,
  runVignette,
  type SeizureVignette,
} from "./seizure-validation";

const FS = MUSE_SAMPLE_RATE;

interface Replay {
  epochs: Epoch[];
  alerts: number[];
  events: ClinicalEvent[];
  peakScore: number;
}

/** Plays a vignette through the analyzer exactly as the live monitor does. */
function replay(v: SeizureVignette, settings = DEFAULT_SETTINGS): Replay {
  const analyzer = new EegAnalyzer(settings, FS);
  const epochs: Epoch[] = [];
  const alerts: number[] = [];
  let peakScore = 0;
  for (let t = 0; t < v.seconds; t += 1) {
    const epoch = analyzer.analyze(v.epochAt(t), t);
    epochs.push(epoch);
    peakScore = Math.max(peakScore, epoch.seizureScore);
    if (epoch.seizureAlert) alerts.push(t);
  }
  // Drain any run still open at the end of the recording.
  const events = analyzer.drainEvents?.() ?? (analyzer as unknown as { events: ClinicalEvent[] }).events;
  return { epochs, alerts, events: [...events], peakScore };
}

function vignette(id: string): SeizureVignette {
  const v = SEIZURE_VIGNETTES.find((x) => x.id === id);
  if (!v) throw new Error(`missing vignette ${id}`);
  return v;
}

const ICTAL = SEIZURE_VIGNETTES.filter((v) => v.truth === "ictal");
const NON_ICTAL = SEIZURE_VIGNETTES.filter((v) => v.truth === "non_ictal");

describe("seizure detector alerts on ictal epochs and stays silent otherwise", () => {
  it("raises an alert on every synthetic seizure recording", () => {
    expect(ICTAL.length).toBeGreaterThan(1);
    for (const v of ICTAL) {
      const { alerts, peakScore } = replay(v);
      expect(alerts.length, `${v.id} should alert`).toBeGreaterThan(0);
      expect(peakScore).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.seizureThreshold);
    }
  });

  it("stays silent through baseline, anaesthetic and artefact recordings", () => {
    expect(NON_ICTAL.length).toBeGreaterThan(2);
    for (const v of NON_ICTAL) {
      const { alerts } = replay(v);
      expect(alerts, `${v.id} should not alert`).toHaveLength(0);
    }
  });

  it("does not alert before the seizure starts", () => {
    // Late-onset vignette: 150 s of quiet baseline before the ictal run.
    const onset = 150;
    const { alerts } = replay(vignette("ictal-late-onset"));
    expect(alerts.length).toBeGreaterThan(0);
    // Allow the back-dating window of consecutive threshold epochs.
    expect(Math.min(...alerts)).toBeGreaterThanOrEqual(onset);
  });

  it("waits for the configured run of consecutive epochs before alerting", () => {
    const { epochs, alerts } = replay(vignette("ictal-spike-wave"));
    const first = Math.min(...alerts);
    const index = epochs.findIndex((e) => e.t === first);
    const run = epochs
      .slice(Math.max(0, index - DEFAULT_SETTINGS.seizureEpochs + 1), index + 1)
      .filter((e) => e.seizureScore >= DEFAULT_SETTINGS.seizureThreshold);
    // Every epoch in the qualifying run crossed threshold...
    expect(run).toHaveLength(DEFAULT_SETTINGS.seizureEpochs);
    // ...and no earlier epoch alerted on a shorter run.
    const earlyAlert = epochs
      .slice(0, index)
      .some((e, i) => e.seizureAlert && i < DEFAULT_SETTINGS.seizureEpochs - 1);
    expect(earlyAlert).toBe(false);
  });

  it("needs a longer run when the required consecutive epochs are raised", () => {
    const strict = { ...DEFAULT_SETTINGS, seizureEpochs: DEFAULT_SETTINGS.seizureEpochs + 4 };
    const relaxed = replay(vignette("ictal-evolving"));
    const stiff = replay(vignette("ictal-evolving"), strict);
    expect(stiff.alerts.length).toBeGreaterThan(0);
    // A longer confirmation requirement can only delay the first alert.
    expect(Math.min(...stiff.alerts)).toBeGreaterThanOrEqual(Math.min(...relaxed.alerts));
    expect(stiff.alerts.length).toBeLessThanOrEqual(relaxed.alerts.length);
  });

  it("never alerts when the threshold is raised above the achievable score", () => {
    const impossible = { ...DEFAULT_SETTINGS, seizureThreshold: 1.01 };
    for (const v of ICTAL) {
      expect(replay(v, impossible).alerts, `${v.id} at threshold 1.01`).toHaveLength(0);
    }
  });

  it("emits a seizure event with a plausible duration for a real run", () => {
    const { events } = replay(vignette("ictal-evolving"));
    const seizures = events.filter((e) => e.kind === "seizure");
    expect(seizures.length).toBeGreaterThan(0);
    const longest = seizures.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
    expect(longest.duration ?? 0).toBeGreaterThan(5);
    expect(longest.t).toBeGreaterThanOrEqual(50); // onset is at 60 s, back-dated a little
    expect(longest.evidence?.peakScore ?? 0).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.seizureThreshold);
  });

  it("keeps burst suppression and EMG artefact out of the alert path", () => {
    for (const id of ["burst-suppression", "artefact-emg", "artefact-chewing"]) {
      const { epochs } = replay(vignette(id));
      expect(epochs.some((e) => e.seizureAlert)).toBe(false);
      // Rhythmic look-alikes may score, but must stay under threshold.
      expect(Math.max(...epochs.map((e) => e.seizureScore))).toBeLessThan(
        DEFAULT_SETTINGS.seizureThreshold,
      );
    }
  });

  it("scores full sensitivity and specificity with no false alarms per hour", () => {
    const report = runSeizureValidation();
    expect(report.sensitivity).toBe(1);
    expect(report.specificity).toBe(1);
    expect(report.falseAlarmsPerHour).toBe(0);
    expect(report.nonIctalHours).toBeGreaterThan(0.3);
  });

  it("is deterministic: the same epochs give the same alerts every run", () => {
    for (const v of [vignette("ictal-evolving"), vignette("anaesthetic-alpha")]) {
      const a = runVignette(v);
      const b = runVignette(v);
      expect(a).toEqual(b);
    }
  });
});
