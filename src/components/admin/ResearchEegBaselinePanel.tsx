import { useRef, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  scoreResearchWindow,
  type ResearchWaveform,
} from "@/lib/eeg/research-eeg-baseline";
import models from "@/lib/eeg/research-eeg-baseline-weights.json";

type Task = "seizure_window" | "bis_agreement_only";
const percent = (value: number) => (value * 100).toFixed(1) + "%";

function isWaveform(value: unknown): value is ResearchWaveform {
  if (!value || typeof value !== "object") return false;
  const waveform = value as Partial<ResearchWaveform>;
  return typeof waveform.hz === "number" &&
    Array.isArray(waveform.channels) &&
    waveform.channels.every((channel) => typeof channel === "string") &&
    Array.isArray(waveform.samples) &&
    waveform.samples.every((signal) => Array.isArray(signal) && signal.every(Number.isFinite)) &&
    (waveform.units === "uV" || waveform.units === "source-amplitude") &&
    waveform.timedAndGapFree === true;
}

export function ResearchEegBaselinePanel() {
  const nextRead = useRef(0);
  const [task, setTask] = useState<Task>("seizure_window");
  const [result, setResult] = useState<{ task: Task; text: string } | null>(null);
  const seizure = task === "seizure_window";
  const metrics = models.seizure.metrics.pooled;

  async function readWindow(file: File) {
    const readId = ++nextRead.current;
    try {
      if (file.size > 250_000) throw new Error("Choose one waveform window under 250 kB.");
      const input: unknown = JSON.parse(await file.text());
      if (!isWaveform(input)) throw new Error("The waveform metadata or samples are invalid.");
      const weights = seizure ? models.seizure.weights : models.bis.weights;
      const score = scoreResearchWindow(task, weights, input);
      if (score === null) throw new Error("The waveform does not match the benchmark format.");
      if (readId !== nextRead.current) return;
      setResult({
        task,
        text: seizure
          ? "Seizure-pattern score " + score.toFixed(3) + " (uncalibrated research score)"
          : "Estimated BIS agreement value " + score.toFixed(1) + " (research comparison)",
      });
    } catch (error) {
      if (readId !== nextRead.current) return;
      setResult({ task, text: error instanceof Error ? error.message : "Could not read waveform." });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">External EEG waveform baselines</CardTitle>
        <CardDescription>
          Offline, research-only comparators for the published recording formats below.
          The seizure baseline missed most labelled windows at the tested threshold.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p>
            CHB-MIT and Siena seizure windows · {metrics.patients} held-out patients ·
            AUROC {metrics.roc_auc.toFixed(3)} · window sensitivity {percent(metrics.window_sensitivity)}
          </p>
          <p>
            Figshare EEG/BIS · {models.bis.test} held-out cases · mean absolute error{" "}
            {models.bis.mae.toFixed(2)} BIS points
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1">
            Benchmark
            <select
              className="rounded border bg-background p-2"
              value={task}
              onChange={(event) => {
                nextRead.current++;
                setResult(null);
                setTask(event.target.value === "bis_agreement_only" ? "bis_agreement_only" : "seizure_window");
              }}
            >
              <option value="seizure_window">CHB-MIT / Siena waveform</option>
              <option value="bis_agreement_only">Figshare BIS waveform</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Research waveform JSON
            <input
              className="max-w-full rounded border p-2"
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void readWindow(file);
              }}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Provide hz, channels, samples (one array per channel), units and timedAndGapFree: true.{" "}
          {seizure
            ? "Use four contiguous seconds at 256 or 512 Hz, FP1-F7 and FP2-F8 in order, and units uV."
            : "Use five contiguous seconds at 125 Hz, channel Figshare BIS frontal, and units source-amplitude."}
          {" "}The file stays in this browser.
        </p>
        {result?.task === task ? <p role="status">{result.text}</p> : null}
        <div className="flex flex-wrap gap-4">
          <a className="underline" href={models.seizure.run}>Seizure benchmark run</a>
          <a className="underline" href={models.bis.run}>BIS benchmark run</a>
        </div>
      </CardContent>
    </Card>
  );
}
