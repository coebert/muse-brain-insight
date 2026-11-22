import { analyseLabSample, type LabSampleId, type LabAnalysis } from "@/lib/eeg/sample-lab";
import { runSampleResearch } from "@/lib/eeg/sample-research";

export type Analysis = "depth" | "seizure" | "age" | "stroke";
type Trace = { label: string; values: number[] };
export type Result = {
  label: string;
  value: string;
  unit?: string;
  explanation: string;
  evidence: string;
  model: string;
  montage: string;
  traces: Trace[];
  initialTraces?: Trace[];
  start: number;
  seconds: number;
  rate: number;
  relativeTime: boolean;
  withheld: boolean;
  metrics: { label: string; value: string }[];
  exposure?: LabAnalysis["exposure"];
};

export function evaluateSample(analysis: Analysis, sample: string): Result {
  if (analysis === "age" || analysis === "stroke") {
    const result = runSampleResearch(analysis, sample);
    return {
      label: result.label,
      value: result.value,
      unit: result.unit,
      explanation: result.description,
      model: result.model,
      evidence: result.evidence,
      montage: result.montage,
      traces: [{ label: analysis === "age" ? "Fp1–F7" : "Left side", values: result.waveform }],
      rate: result.sampleRate,
      relativeTime: true,
      withheld: result.state === "withheld",
      start: 0,
      seconds: result.waveform.length / result.sampleRate,
      metrics: [],
    };
  }
  const result = analyseLabSample(sample as LabSampleId);
  const depth = analysis === "depth";
  const score = depth ? result.depthIndex : result.seizureScore;
  const depthConflict =
    depth && score != null && score >= 70 && (result.suppressionPercent ?? 0) >= 30;
  const percentage = (value: number | null) =>
    value == null ? "Unavailable" : value.toFixed(1) + "%";
  const metrics = depth
    ? [
        { label: "Suppression ratio · final 60 s", value: percentage(result.suppressionPercent) },
        ...(sample === "emg"
          ? [
              {
                label: "High-frequency power · initial",
                value: percentage(result.emgBeforePercent),
              },
            ]
          : []),
        { label: "High-frequency power · final", value: percentage(result.emgPowerPercent) },
        {
          label: "Dominant frequency",
          value: result.dominantHz == null ? "Unavailable" : result.dominantHz.toFixed(1) + " Hz",
        },
      ]
    : [
        {
          label: "Peak pattern score",
          value:
            result.peakSeizureScore == null ? "Unavailable" : result.peakSeizureScore.toFixed(2),
        },
        {
          label: "Alert during replay",
          value:
            result.peakSeizureScore == null
              ? "Unavailable"
              : result.anySeizureAlert
                ? "Triggered"
                : "No alert",
        },
        { label: "Frontal delta asymmetry", value: percentage(result.asymmetryPercent) },
      ];
  return {
    label: depth ? "Depth index" : "Final seizure pattern score",
    value: score == null ? "Withheld" : depth ? Math.round(score).toString() : score.toFixed(2),
    unit: score == null ? "" : depth ? "/ 100" : "/ 1.00",
    explanation:
      score == null
        ? "This example does not supply enough usable signal for this output."
        : depthConflict
          ? "This high research index conflicts with substantial suppression in the same sample. The index cannot establish awareness."
          : depth
            ? "The smoothed index at the end of the sample summarises depth-related signal features from AF7."
            : result.seizureAlert
              ? "The detector's alert rule was active in the final four-second window."
              : "The detector's alert rule was inactive in the final four-second window.",
    evidence: depth
      ? "The suppression ratio is the fraction of the last minute spent in suppression. High-frequency power measures the share of 0.5–80 Hz power between 30 and 80 Hz. A change in this share alone cannot establish a change in consciousness."
      : "The alert requires three consecutive one-second decisions to meet the detector threshold. The score measures pattern strength in the synthetic EEG. Clinical seizure probability is unknown.",
    model: depth
      ? "COEBIS-2 depth index (0–100)"
      : "EEG analyser · rhythmicity, line length and spectral evidence",
    montage: result.traces.map((t) => t.label).join(" · ") + " (AF7 for scoring)",
    traces: result.traces,
    initialTraces: result.initialTraces,
    start: result.traceStartSeconds,
    seconds: result.traceSeconds,
    rate: result.sampleRate,
    relativeTime: false,
    withheld: score == null,
    metrics,
    exposure: depth ? result.exposure : null,
  };
}
