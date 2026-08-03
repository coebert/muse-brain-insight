import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Cpu,
  Info,
  ShieldAlert,
  SlidersHorizontal,
  Copy,
  Check,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildCalibrationAdvice,
  type CalibrationRecommendation,
} from "@/lib/eeg/calibration-advice";
import type { ModelPerformance } from "@/lib/eeg/model-performance.functions";

const KIND_ICON = {
  raise_threshold: ArrowUpRight,
  lower_threshold: ArrowDownRight,
  reweight_confidence: SlidersHorizontal,
  severity: ShieldAlert,
  model_version: Cpu,
  collect_more: Info,
} as const;

const SCOPE_LABEL: Record<CalibrationRecommendation["scope"], string> = {
  category: "Category",
  severity: "Severity",
  model: "Model version",
  confidence: "Confidence band",
  overall: "Global",
};

function priorityClass(p: CalibrationRecommendation["priority"]): string {
  if (p === "high") return "border-critical/50 text-critical";
  if (p === "medium") return "border-caution/50 text-caution";
  return "border-border text-muted-foreground";
}

function RecommendationRow({ r }: { r: CalibrationRecommendation }) {
  const Icon = KIND_ICON[r.kind];
  return (
    <li className="rounded-md border border-border/70 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-marker" aria-hidden />
        <span className="text-sm font-medium">{r.title}</span>
        <Badge variant="outline" className={`text-xs ${priorityClass(r.priority)}`}>
          {r.priority} priority
        </Badge>
        <Badge variant="outline" className="text-xs text-muted-foreground">
          {SCOPE_LABEL[r.scope]}
        </Badge>
        <span className="metric-value ml-auto text-xs text-muted-foreground">
          {r.agreement == null ? "—" : `${Math.round(r.agreement * 100)}% agreement`} · n={r.sample}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{r.rationale}</p>
      <p className="mt-1 text-xs">{r.action}</p>
      {r.confidenceWeight != null || r.evidenceBar ? (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {r.confidenceWeight != null ? (
            <span className="metric-value">
              Suggested confidence weight ×{r.confidenceWeight.toFixed(2)}
            </span>
          ) : null}
          {r.evidenceBar ? <span>Evidence bar: {r.evidenceBar}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Turns measured agreement rates into recommended threshold / weighting changes,
 * grouped by category, severity, confidence band and model version.
 */
export function CalibrationPanel({ performance }: { performance: ModelPerformance }) {
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const advice = useMemo(() => buildCalibrationAdvice(performance), [performance]);

  const visible = showAll
    ? advice.recommendations
    : advice.recommendations.filter((r) => r.priority !== "low");
  const hidden = advice.recommendations.length - visible.length;

  async function copyPlan() {
    const text = advice.recommendations
      .map(
        (r) =>
          `- [${r.priority}] ${SCOPE_LABEL[r.scope]} · ${r.target}: ${r.action}` +
          (r.confidenceWeight != null ? ` (weight ×${r.confidenceWeight.toFixed(2)})` : "") +
          `\n  ${r.rationale}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(`Calibration plan — ${advice.summary}\n${text}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5 text-marker" aria-hidden /> Model calibration
          recommendations
        </h2>
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={copyPlan}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy plan"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{advice.summary}</p>
      {advice.underpowered ? (
        <p className="mt-1 text-xs text-caution">
          Treat these as provisional until more alerts are graded.
        </p>
      ) : null}

      {visible.length ? (
        <ul className="mt-3 space-y-2">
          {visible.map((r) => (
            <RecommendationRow key={r.id} r={r} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No threshold or weighting changes indicated for this window.
        </p>
      )}

      {hidden > 0 && !showAll ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-3 h-7 text-xs"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} low-priority note{hidden === 1 ? "" : "s"}
        </Button>
      ) : null}
      {showAll ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-3 h-7 text-xs"
          onClick={() => setShowAll(false)}
        >
          Hide low-priority notes
        </Button>
      ) : null}
    </section>
  );
}