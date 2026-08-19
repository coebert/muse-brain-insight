/**
 * Why the COEBIS number is missing.
 *
 * With no fitted correction the depth tile silently falls back to the open
 * index, which reads as "the app is broken" at the bedside. This banner names
 * the inputs COEBIS still needs — paired readings, independent cases, case
 * linkage, signal quality — with the count required for each, and offers an
 * immediate refit once they are in place.
 */
import { activeLineageKey } from "@/lib/eeg/model-lineage";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { useCoebisRefit } from "@/components/monitor/CoebisModelPicker";
import { useCoebisModel } from "@/hooks/useCoebisModel";
import { getBisDrift } from "@/lib/eeg/bis-drift.functions";
import { evaluateCoebisSufficiency, type SufficiencyCheck } from "@/lib/eeg/coebis-sufficiency";
import { cn } from "@/lib/utils";

function CheckRow({ check }: { check: SufficiencyCheck }) {
  const Icon =
    check.status === "pass" ? CheckCircle2 : check.status === "partial" ? CircleDashed : AlertTriangle;
  const tone =
    check.status === "pass"
      ? "text-signal"
      : check.status === "partial"
        ? "text-caution"
        : "text-destructive";
  return (
    <li className="flex items-start gap-2">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone)} aria-hidden />
      <span className="min-w-0">
        <span className="text-xs font-medium">{check.label}</span>
        <span className="block text-[11px] text-muted-foreground">{check.detail}</span>
        <span className="block text-[11px] text-muted-foreground">Needs: {check.requirement}</span>
      </span>
    </li>
  );
}

export function CoebisUnavailableBanner({ className }: { className?: string }) {
  const model = useCoebisModel();
  const fetchDrift = useServerFn(getBisDrift);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["bis-drift"],
    queryFn: () => fetchDrift({ data: { lineage: activeLineageKey() } }),
    enabled: !model,
    staleTime: 60_000,
  });

  const refit = useCoebisRefit(() =>
    queryClient.invalidateQueries({ queryKey: ["bis-drift"] }).then(() => undefined),
  );

  // A live model means the number is on screen — nothing to explain.
  if (model) return null;

  const analysis = data?.analysis ?? null;
  const sufficiency = evaluateCoebisSufficiency(analysis, null);
  // Only the inputs that are actually holding the model back.
  const blocking = sufficiency.checks.filter((c) => c.status === "fail" || c.status === "partial");

  return (
    <section
      className={cn("rounded-lg border border-caution/40 bg-caution/5 p-3", className)}
      aria-label="COEBIS uncalibrated"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="size-4 text-caution" aria-hidden />
            COEBIS uncalibrated — running on the baseline correction
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isLoading ? "Checking what paired data has been logged…" : sufficiency.headline}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={refit.running}
          onClick={() => void refit.run()}
        >
          {refit.running ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
          )}
          Recompute
        </Button>
      </div>

      {blocking.length ? (
        <ul className="mt-2.5 grid gap-2 sm:grid-cols-2">
          {blocking.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      ) : null}

      {sufficiency.nextStep ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{sufficiency.nextStep}</p>
      ) : null}
    </section>
  );
}
