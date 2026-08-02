import { AlertTriangle, Brain, Info, Loader2, ShieldAlert, Sparkles, Tag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ClinicalAlert, Interpretation } from "@/lib/eeg/interpret.functions";

const CONFIDENCE_TONE: Record<string, string> = {
  high: "bg-critical/15 text-critical",
  moderate: "bg-caution/15 text-caution",
  low: "bg-muted text-muted-foreground",
};

const ALERT_TONE: Record<ClinicalAlert["severity"], string> = {
  critical: "border-critical/50 bg-critical/10 text-critical",
  warning: "border-caution/50 bg-caution/10 text-caution",
  advisory: "border-border bg-muted/40 text-muted-foreground",
};

function formatClockSeconds(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Props {
  result: Interpretation | null;
  loading: boolean;
  error: string | null;
  epochCount: number;
  onRun: () => void;
  /** Continuous background surveillance while streaming. */
  watch?: boolean;
  onWatchChange?: (next: boolean) => void;
  lastRunAt?: number | null;
  /** Label for the run button, e.g. "Review saved case". */
  runLabel?: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <p className="mt-1 text-sm leading-relaxed">{children}</p>
    </div>
  );
}

export function AiInsightPanel({
  result,
  loading,
  error,
  epochCount,
  onRun,
  watch,
  onWatchChange,
  lastRunAt,
  runLabel,
}: Props) {
  const enoughData = epochCount >= 30;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <Brain className="h-4 w-4 text-marker" aria-hidden />
        <h2 className="text-sm font-semibold">AI interpretation &amp; alerts</h2>
        <span className="text-[11px] text-muted-foreground">
          Quantitative digest only — no raw EEG or identifiers leave the device
        </span>
        {onWatchChange ? (
          <div className="flex items-center gap-2 sm:ml-auto">
            <Switch id="ai-watch" checked={Boolean(watch)} onCheckedChange={onWatchChange} />
            <Label htmlFor="ai-watch" className="text-[11px] text-muted-foreground">
              Continuous surveillance
            </Label>
          </div>
        ) : null}
        <Button
          size="sm"
          className={onWatchChange ? undefined : "sm:ml-auto"}
          onClick={onRun}
          disabled={loading || !enoughData}
          title={enoughData ? undefined : "Record at least 30 s of EEG first"}
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Analysing…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" /> {runLabel ?? "Analyse session"}
            </>
          )}
        </Button>
        {lastRunAt ? (
          <span className="metric-value w-full text-[10px] text-muted-foreground sm:w-auto">
            Last reviewed {new Date(lastRunAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      <div className="space-y-4 px-4 py-4">
        {error ? <p className="text-sm text-critical">{error}</p> : null}

        {!result && !error ? (
          <p className="text-sm text-muted-foreground">
            Reviews depth of anaesthesia, burst suppression, ictal risk and possible indicators of
            cerebral pathology from the session&apos;s spectral, suppression and quality metrics
            together with your timeline markers and the demographics and admission details you
            enter. Turn on continuous surveillance to re-review automatically and raise alerts
            while you monitor.
          </p>
        ) : null}

        {result ? (
          <>
            <p className="text-sm font-medium leading-relaxed">{result.headline}</p>

            {result.alerts?.length ? (
              <ul className="space-y-2">
                {result.alerts.map((a) => (
                  <li key={a.id} className={`rounded-md border p-3 ${ALERT_TONE[a.severity] ?? ALERT_TONE.advisory}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      {a.severity === "advisory" ? (
                        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      )}
                      <span className="text-sm font-semibold">{a.title}</span>
                      <span className="metric-value rounded-full bg-background/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
                        {a.severity} · {a.confidence} confidence
                      </span>
                      {a.tSeconds != null ? (
                        <span className="metric-value text-[10px] opacity-80">
                          @ {formatClockSeconds(a.tSeconds)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-foreground">{a.detail}</p>
                    {a.action ? (
                      <p className="mt-1 text-xs font-medium">Suggested action: {a.action}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                No actionable alerts raised from this review.
              </p>
            )}

            <div className="grid gap-4 md:grid-cols-3">
              <Section title="Depth / background">{result.depthOfAnaesthesia}</Section>
              <Section title="Burst suppression">{result.burstSuppression}</Section>
              <Section title="Ictal risk">{result.seizureRisk}</Section>
            </div>

            {result.markerCorrelations?.length ? (
              <div>
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Tag className="h-3 w-3" aria-hidden /> Response to your markers
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                  {result.markerCorrelations.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {result.pathologyIndicators?.length ? (
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Possible cerebral pathology indicators
                </h3>
                <ul className="mt-2 space-y-2">
                  {result.pathologyIndicators.map((f) => (
                    <li key={f.title} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{f.title}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                            CONFIDENCE_TONE[f.confidence] ?? CONFIDENCE_TONE["low"]
                          }`}
                        >
                          {f.confidence} confidence
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed">{f.detail}</p>
                      {f.supporting?.length ? (
                        <p className="metric-value mt-1.5 text-[11px] text-muted-foreground">
                          {f.supporting.join(" · ")}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2">
              {result.recommendedChecks?.length ? (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Suggested next checks
                  </h3>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                    {result.recommendedChecks.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result.limitations?.length ? (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Montage limitations
                  </h3>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                    {result.limitations.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {result.dataQualityCaveat ? (
              <p className="text-xs text-muted-foreground">{result.dataQualityCaveat}</p>
            ) : null}

            <p className="flex items-start gap-2 rounded-md bg-caution/10 p-3 text-xs text-caution">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              AI-generated decision support from a consumer 4-channel frontal montage. Not a
              diagnosis and not a substitute for formal EEG reporting or clinical judgement.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
