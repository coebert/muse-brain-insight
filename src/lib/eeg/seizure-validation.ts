import { EPOCH_SECONDS, EegAnalyzer, DEFAULT_SETTINGS, type AnalysisSettings } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";

/**
 * Labelled validation pack for the seizure detector, mirroring the depth
 * validation harness: synthetic but physiologically shaped vignettes with a
 * known ground truth, scored for sensitivity, specificity and false-alarm
 * rate per hour so a threshold change can be judged rather than guessed.
 */

export type VignetteTruth = "ictal" | "non_ictal";

export interface SeizureVignette {
  id: string;
  label: string;
  truth: VignetteTruth;
  /** Recording length in seconds. */
  seconds: number;
  /** Sample generator for one epoch starting at `t` seconds. */
  epochAt: (t: number) => Float64Array;
}

const N = EPOCH_SECONDS * MUSE_SAMPLE_RATE;

/** Deterministic pseudo-noise so runs are reproducible across machines. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
}

interface Component {
  hz: number;
  amp: number;
}

function synth(
  t: number,
  components: Component[],
  opts: { noiseUv?: number; seed?: number; emgUv?: number } = {},
): Float64Array {
  const w = new Float64Array(N);
  const rnd = noise((opts.seed ?? 7) + Math.round(t) * 131);
  for (let i = 0; i < N; i++) {
    const time = t + i / MUSE_SAMPLE_RATE;
    let v = 0;
    for (const c of components) v += c.amp * Math.sin(2 * Math.PI * c.hz * time);
    if (opts.noiseUv) v += opts.noiseUv * rnd();
    if (opts.emgUv) v += opts.emgUv * Math.sin(2 * Math.PI * 62 * time) * (0.6 + rnd());
    w[i] = v;
  }
  return w;
}

/** Rhythmic 3 Hz ictal discharge that evolves in frequency and amplitude. */
function evolvingIctal(onset: number, seconds: number) {
  return (t: number) => {
    if (t < onset) return synth(t, [{ hz: 1.5, amp: 25 }, { hz: 9, amp: 12 }], { noiseUv: 6 });
    const phase = Math.min(1, (t - onset) / Math.max(1, seconds - onset));
    const hz = 2.5 + phase * 3;
    const amp = 60 + phase * 70;
    return synth(t, [
      { hz, amp },
      { hz: hz * 2, amp: amp * 0.4 },
    ], { noiseUv: 5 });
  };
}

export const SEIZURE_VIGNETTES: SeizureVignette[] = [
  {
    id: "ictal-evolving",
    label: "Evolving rhythmic 3→5 Hz ictal run, ICU sedation",
    truth: "ictal",
    seconds: 180,
    epochAt: evolvingIctal(60, 180),
  },
  {
    id: "ictal-spike-wave",
    label: "High-amplitude spike-and-wave, 3 Hz with harmonics",
    truth: "ictal",
    seconds: 120,
    epochAt: (t) =>
      t < 40
        ? synth(t, [{ hz: 2, amp: 25 }], { noiseUv: 6 })
        : synth(t, [
            { hz: 3, amp: 110 },
            { hz: 6, amp: 55 },
            { hz: 9, amp: 28 },
          ], { noiseUv: 5 }),
  },
  {
    id: "ictal-late-onset",
    label: "Late-onset 4 Hz seizure after a quiet baseline",
    truth: "ictal",
    seconds: 240,
    epochAt: evolvingIctal(150, 240),
  },
  {
    id: "artefact-emg",
    label: "Sustained frontal EMG (light plane, jaw tension)",
    truth: "non_ictal",
    seconds: 180,
    epochAt: (t) => synth(t, [{ hz: 10, amp: 18 }], { noiseUv: 8, emgUv: 45 }),
  },
  {
    id: "artefact-chewing",
    label: "Rhythmic chewing / ventilator artefact at 1.6 Hz",
    truth: "non_ictal",
    seconds: 180,
    epochAt: (t) => synth(t, [{ hz: 1.6, amp: 90 }], { noiseUv: 10, emgUv: 25 }),
  },
  {
    id: "anaesthetic-alpha",
    label: "Propofol maintenance: frontal alpha over delta",
    truth: "non_ictal",
    seconds: 300,
    epochAt: (t) =>
      synth(t, [
        { hz: 10, amp: 30 },
        { hz: 1.2, amp: 45 },
      ], { noiseUv: 7 }),
  },
  {
    id: "slow-delta",
    label: "Deep sedation: monotonous 1 Hz delta",
    truth: "non_ictal",
    seconds: 300,
    epochAt: (t) => synth(t, [{ hz: 1, amp: 70 }], { noiseUv: 8 }),
  },
  {
    id: "burst-suppression",
    label: "Burst suppression, 40 % suppressed",
    truth: "non_ictal",
    seconds: 240,
    epochAt: (t) =>
      Math.floor(t / 8) % 5 < 2
        ? synth(t, [{ hz: 9, amp: 2 }], { noiseUv: 0.5 })
        : synth(t, [
            { hz: 3, amp: 80 },
            { hz: 12, amp: 30 },
          ], { noiseUv: 6 }),
  },
];

export interface VignetteResult {
  id: string;
  label: string;
  truth: VignetteTruth;
  seconds: number;
  /** Whether the detector raised at least one seizure alert. */
  alerted: boolean;
  alerts: number;
  peakScore: number;
  /** Seconds from true onset to first alert, when both exist. */
  firstAlertT: number | null;
}

export function runVignette(
  v: SeizureVignette,
  settings: AnalysisSettings = DEFAULT_SETTINGS,
): VignetteResult {
  const analyzer = new EegAnalyzer(settings);
  let alerts = 0;
  let peak = 0;
  let firstAlertT: number | null = null;
  for (let t = 0; t < v.seconds; t++) {
    const epoch = analyzer.analyze(v.epochAt(t), t);
    if (epoch.seizureScore > peak) peak = epoch.seizureScore;
    if (epoch.seizureAlert) {
      alerts++;
      if (firstAlertT === null) firstAlertT = t;
    }
  }
  return {
    id: v.id,
    label: v.label,
    truth: v.truth,
    seconds: v.seconds,
    alerted: alerts > 0,
    alerts,
    peakScore: Number(peak.toFixed(3)),
    firstAlertT,
  };
}

export interface SeizureValidationReport {
  results: VignetteResult[];
  truePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  falsePositives: number;
  /** Detected ictal vignettes / all ictal vignettes. */
  sensitivity: number;
  /** Clean non-ictal vignettes / all non-ictal vignettes. */
  specificity: number;
  /** Alerts raised on non-ictal recordings, scaled to one hour. */
  falseAlarmsPerHour: number;
  /** Hours of non-ictal recording scored. */
  nonIctalHours: number;
}

export function runSeizureValidation(
  settings: AnalysisSettings = DEFAULT_SETTINGS,
  vignettes: SeizureVignette[] = SEIZURE_VIGNETTES,
): SeizureValidationReport {
  const results = vignettes.map((v) => runVignette(v, settings));
  const ictal = results.filter((r) => r.truth === "ictal");
  const clean = results.filter((r) => r.truth === "non_ictal");
  const tp = ictal.filter((r) => r.alerted).length;
  const fp = clean.filter((r) => r.alerted).length;
  const nonIctalSeconds = clean.reduce((sum, r) => sum + r.seconds, 0);
  const falseAlertEpochs = clean.reduce((sum, r) => sum + r.alerts, 0);
  const hours = nonIctalSeconds / 3600;
  return {
    results,
    truePositives: tp,
    falseNegatives: ictal.length - tp,
    trueNegatives: clean.length - fp,
    falsePositives: fp,
    sensitivity: ictal.length ? tp / ictal.length : 0,
    specificity: clean.length ? (clean.length - fp) / clean.length : 0,
    falseAlarmsPerHour: hours ? falseAlertEpochs / hours : 0,
    nonIctalHours: Number(hours.toFixed(3)),
  };
}

/** Markdown record of a validation run, for the published dossier. */
export function seizureValidationMarkdown(report: SeizureValidationReport): string {
  const rows = report.results
    .map(
      (r) =>
        `| ${r.label} | ${r.truth === "ictal" ? "ictal" : "non-ictal"} | ${r.seconds} s | ${
          r.alerted ? "alert" : "no alert"
        } | ${r.alerts} | ${r.peakScore} | ${r.firstAlertT ?? "—"} |`,
    )
    .join("\n");
  return [
    "# Seizure detector validation pack",
    "",
    "Synthetic labelled vignettes scored through the live `EegAnalyzer` at the",
    "shipped detection settings. Regenerate with `bunx vitest run seizure-validation`.",
    "",
    `- Sensitivity: ${(report.sensitivity * 100).toFixed(0)} % (${report.truePositives}/${
      report.truePositives + report.falseNegatives
    } ictal vignettes)`,
    `- Specificity: ${(report.specificity * 100).toFixed(0)} % (${report.trueNegatives}/${
      report.trueNegatives + report.falsePositives
    } non-ictal vignettes)`,
    `- False alarms per hour: ${report.falseAlarmsPerHour.toFixed(1)} over ${report.nonIctalHours} h of non-ictal recording`,
    "",
    "| Vignette | Truth | Length | Verdict | Alert epochs | Peak score | First alert (s) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    rows,
    "",
    "These are shaped synthetic traces, not human recordings: they bound detector",
    "behaviour against known patterns and artefacts, and are not evidence of clinical",
    "sensitivity in patients.",
    "",
  ].join("\n");
}

/**
 * False alarms per hour measured on the non-ictal vignettes at the shipped
 * detection settings (see `seizure-validation.md`). Used to contextualise how
 * many alerting runs a recording of a given length could produce from noise.
 */
export const RECORDED_FALSE_ALARMS_PER_HOUR = 0;
