import { Activity, Loader2, Sparkles, Syringe, TrendingDown, TrendingUp, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/eeg/format";
import { correlationStrength } from "@/lib/eeg/correlation";
import type { TciResponseDigest } from "@/lib/eeg/tci-response";
import type { TciResponseReport } from "@/lib/eeg/tci-response.functions";
import { cn } from "@/lib/utils";

const EFFECT_TONE: Record<string, string> = {
  expected: "bg-signal/15 text-signal",
  exaggerated: "bg-caution/15 text-caution",
  blunted: "bg-muted text-muted-foreground",
  paradoxical: "bg-critical/15 text-critical",
  none: "bg-muted text-muted-foreground",
};

const CONFIDENCE_TONE: Record<string, string> = {
  high: "bg-critical/15 text-critical",
  moderate: "bg-caution/15 text-caution",
  low: "bg-muted text-muted-foreground",
};

/** Metrics worth surfacing on the local (non-AI) dose–response summary. */
const KEY_METRICS = ["Depth index", "SEF95", "Suppression ratio", "Seizure score"];

/**
 * Relates recorded TCI target changes to the spectral, burst-suppression and
 * seizure-risk trends: a locally computed dose–response summary plus an AI
 * reading of what the dosing appears to be doing to this brain.
 */
export function TciResponsePanel({
  digest,
  report,
  loading,
  error,
  onRun,
}: {
  digest: TciResponseDigest;
  report: TciResponseReport | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const canRun = !digest.sparse && digest.steps.length > 0;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <Syringe className="h-4 w-4 text-signal" aria-hidden />
        <h2 className="text-sm font-semibold">Dosing impact — TCI vs EEG</h2>
        <span className="text-xs text-muted-foreground">
          Recorded Ce targets read against spectral, suppression and seizure trends
        </span>
        <Button
          size="sm"
          className="sm:ml-auto"
          onClick={onRun}
          disabled={loading || !canRun}
          title={canRun ? undefined : "Record a TCI target change with EEG running first"}
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Analysing…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" /> Analyse dosing impact
            </>
          )}
        </Button>
      </div>

      <div className="space-y-4 px-4 py-3">
        {error ? <p className="text-xs text-critical">{error}</p> : null}

        {digest.sparse ? (
          <p className="text-sm text-muted-foreground">
            No TCI pumps recorded yet. Add a pump and its effect-site target so dosing can be
            correlated with the EEG.
          </p>
        ) : null}

        {/* Locally computed, always-available response table. */}
        {digest.steps.length ? (
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Response to each target change
            </h3>
            <ul className="mt-1.5 space-y-1.5">
              {digest.steps.slice(-6).reverse().map((s) => (
                <li
                  key={`${s.drug}-${s.tSeconds}`}
                  className="rounded-md border border-border bg-card/50 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="metric-value text-muted-foreground">
                      {formatClock(s.tSeconds)}
                    </span>
                    <span className="font-medium text-foreground">
                      {s.model} · {s.drug}
                    </span>
                    <span className="metric-value flex items-center gap-1 text-signal">
                      {s.direction === "decrease" ? (
                        <TrendingDown className="size-3.5" />
                      ) : (
                        <TrendingUp className="size-3.5" />
                      )}
                      {s.fromCe != null ? `${s.fromCe} → ` : ""}
                      {s.toCe} {s.unit}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {s.deltas
                      .filter((d) => KEY_METRICS.includes(d.metric) && d.change != null)
                      .map((d) => (
                        <span key={d.metric} className="metric-value text-xs">
                          <span className="text-muted-foreground">{d.metric} </span>
                          <span
                            className={cn(
                              (d.change ?? 0) > 0 ? "text-caution" : "text-signal",
                              Math.abs(d.change ?? 0) < 0.5 && "text-muted-foreground",
                            )}
                          >
                            {(d.change ?? 0) > 0 ? "+" : ""}
                            {d.change}
                          </span>
                        </span>
                      ))}
                  </div>
                  {s.followedBy.length ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-caution">
                      <Zap className="size-3" /> {s.followedBy.length} event
                      {s.followedBy.length === 1 ? "" : "s"} within 4 min —{" "}
                      {s.followedBy[0]!.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {digest.doseResponse.length ? (
          <div>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Dose–response across the case
            </h3>
            <ul className="mt-1.5 space-y-1.5">
              {digest.doseResponse.map((d) => (
                <li
                  key={`${d.model}-${d.drug}`}
                  className="rounded-md border border-border bg-card/50 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Activity className="size-3.5 text-signal" />
                    <span className="font-medium">
                      {d.model} · {d.drug}
                    </span>
                    <span className="metric-value text-muted-foreground">
                      Ce {d.minCe}–{d.maxCe} {d.unit}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {d.correlations
                      .filter((c) => KEY_METRICS.includes(c.metric) && c.r != null)
                      .map((c) => (
                        <span key={c.metric} className="metric-value text-xs">
                          <span className="text-muted-foreground">{c.metric} </span>r = {c.r}{" "}
                          <span className="text-muted-foreground">
                            ({correlationStrength(c.r)})
                          </span>
                        </span>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {report ? (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-sm leading-relaxed font-medium">{report.headline}</p>
            <Block title="Spectral" text={report.spectralResponse} />
            <Block title="Burst suppression" text={report.suppressionResponse} />
            <Block title="Seizure risk" text={report.seizureResponse} />

            {report.findings.length ? (
              <div>
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Findings
                </h3>
                <ul className="mt-1.5 space-y-2">
                  {report.findings.map((f, i) => (
                    <li key={i} className="rounded-md border border-border bg-card/50 px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium">
                          {f.drug} · {f.domain}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            EFFECT_TONE[f.effect] ?? EFFECT_TONE["none"],
                          )}
                        >
                          {f.effect}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            CONFIDENCE_TONE[f.confidence] ?? CONFIDENCE_TONE["low"],
                          )}
                        >
                          {f.confidence} confidence
                        </span>
                        {f.tSeconds != null ? (
                          <span className="metric-value text-xs text-muted-foreground">
                            {formatClock(f.tSeconds)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm leading-relaxed">{f.detail}</p>
                      {f.supporting.length ? (
                        <ul className="mt-1 flex flex-wrap gap-1.5">
                          {f.supporting.map((s, j) => (
                            <li
                              key={j}
                              className="metric-value rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                            >
                              {s}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.titrationSuggestions.length ? (
              <List title="Titration considerations" items={report.titrationSuggestions} />
            ) : null}
            {report.limitations.length ? (
              <List title="Limitations" items={report.limitations} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Decision support only — not a diagnosis, and the pump owns the pharmacokinetic model.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <p className="mt-1 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
