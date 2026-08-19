import { useCallback, useState } from "react";
import { FlaskConical, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DEFAULT_SETTINGS, type AnalysisSettings } from "@/lib/eeg/analysis";
import {
  SEIZURE_VIGNETTES,
  runVignette,
  type SeizureValidationReport,
  type VignetteResult,
} from "@/lib/eeg/seizure-validation";
import { cn } from "@/lib/utils";

/** Yields to the browser between vignettes so the monitor keeps painting. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Scores the labelled vignette pack through the live detector one vignette at a
 * time. Running it in the app (rather than only in CI) means the numbers shown
 * belong to the thresholds actually in force at the bedside.
 */
export async function runValidationIncrementally(
  settings: AnalysisSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<SeizureValidationReport> {
  const results: VignetteResult[] = [];
  for (const v of SEIZURE_VIGNETTES) {
    results.push(runVignette(v, settings));
    onProgress?.(results.length, SEIZURE_VIGNETTES.length);
    await yieldToUi();
  }
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

export interface SeizureValidationState {
  report: SeizureValidationReport | null;
  running: boolean;
  progress: { done: number; total: number };
  run: () => void;
}

/** Shared runner so the dashboard and the case timeline show the same numbers. */
export function useSeizureValidation(settings: AnalysisSettings): SeizureValidationState {
  const [report, setReport] = useState<SeizureValidationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: SEIZURE_VIGNETTES.length });

  const run = useCallback(() => {
    setRunning(true);
    setProgress({ done: 0, total: SEIZURE_VIGNETTES.length });
    void runValidationIncrementally(settings, (done, total) => setProgress({ done, total }))
      .then(setReport)
      .finally(() => setRunning(false));
  }, [settings]);

  return { report, running, progress, run };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)} %`;
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
  hint: string;
}) {
  return (
    <div className="rounded-md border border-border px-2.5 py-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          "metric-value text-lg",
          tone === "good" && "text-success",
          tone === "warn" && "text-caution",
          tone === "bad" && "text-critical",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Detector performance at the thresholds currently in force, measured against
 * the labelled vignette pack (ictal runs, spike-and-wave, EMG, rhythmic
 * artefact, propofol alpha, delta, burst suppression).
 */
export function SeizureValidationPanel({
  settings,
  className,
}: {
  settings: AnalysisSettings;
  className?: string;
}) {
  const { report, running, progress, run } = useSeizureValidation(settings);
  const tuned =
    settings.seizureThreshold !== DEFAULT_SETTINGS.seizureThreshold ||
    settings.seizureEpochs !== DEFAULT_SETTINGS.seizureEpochs;

  return (
    <section className={cn("panel px-3 py-3 sm:px-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <FlaskConical className="size-3.5" />
            Detector check
          </h2>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Scores the labelled vignette pack through the detector at your current settings —
            threshold {settings.seizureThreshold.toFixed(2)} over {settings.seizureEpochs} epochs
            {tuned ? " (tuned away from the shipped defaults)" : " (shipped defaults)"}.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 shrink-0 gap-1.5 sm:min-h-9"
          disabled={running}
          onClick={run}
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {running
            ? `Scoring ${progress.done}/${progress.total}`
            : report
              ? "Re-run check"
              : "Run check"}
        </Button>
      </div>

      {report ? (
        <>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Stat
              label="Sensitivity"
              value={pct(report.sensitivity)}
              tone={report.sensitivity >= 1 ? "good" : report.sensitivity >= 0.67 ? "warn" : "bad"}
              hint={`${report.truePositives}/${report.truePositives + report.falseNegatives} ictal vignettes detected`}
            />
            <Stat
              label="Specificity"
              value={pct(report.specificity)}
              tone={report.specificity >= 1 ? "good" : report.specificity >= 0.8 ? "warn" : "bad"}
              hint={`${report.trueNegatives}/${report.trueNegatives + report.falsePositives} non-ictal vignettes stayed quiet`}
            />
            <Stat
              label="False alarms / h"
              value={report.falseAlarmsPerHour.toFixed(1)}
              tone={
                report.falseAlarmsPerHour === 0
                  ? "good"
                  : report.falseAlarmsPerHour <= 2
                    ? "warn"
                    : "bad"
              }
              hint={`over ${report.nonIctalHours} h of non-ictal material`}
            />
          </div>

          {report.falseNegatives > 0 || report.falsePositives > 0 ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-md border border-caution/40 bg-caution/10 px-2.5 py-2 text-[11px] text-caution">
              <ShieldAlert className="mt-px size-3.5 shrink-0" />
              These thresholds miss {report.falseNegatives} ictal pattern
              {report.falseNegatives === 1 ? "" : "s"} and alert on {report.falsePositives}{" "}
              non-ictal pattern{report.falsePositives === 1 ? "" : "s"}. Loosen or tighten the
              seizure threshold in detection settings before relying on the alarm.
            </p>
          ) : (
            <p className="mt-2 flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 py-2 text-[11px] text-success">
              <ShieldCheck className="mt-px size-3.5 shrink-0" />
              Every ictal vignette alerted and no artefact or sedation pattern did at these
              settings.
            </p>
          )}

          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="mt-2 min-h-11 px-2 text-xs sm:min-h-9">
                Per-vignette detail
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 space-y-1">
                {report.results.map((r) => {
                  const correct = r.truth === "ictal" ? r.alerted : !r.alerted;
                  return (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border px-2.5 py-1.5 text-[11px]"
                    >
                      <span className="min-w-0 flex-1 truncate">{r.label}</span>
                      <span className="metric-value text-muted-foreground">
                        peak {r.peakScore.toFixed(2)}
                      </span>
                      <span
                        className={cn(
                          "rounded-sm px-1.5 py-0.5",
                          correct
                            ? "bg-success/15 text-success"
                            : "bg-critical/15 text-critical",
                        )}
                      >
                        {r.truth === "ictal"
                          ? r.alerted
                            ? `alerted at ${r.firstAlertT ?? 0} s`
                            : "missed"
                          : r.alerted
                            ? `${r.alerts} false epochs`
                            : "quiet"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Not yet run this session. The check takes a few seconds and does not touch patient data.
        </p>
      )}

      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Shaped synthetic traces, not human recordings: they bound detector behaviour against known
        patterns and artefacts and are not evidence of clinical sensitivity in patients.
      </p>
    </section>
  );
}
