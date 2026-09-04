/**
 * Phase 5 — "Why this number?" for COEBIS.
 *
 * Shows the exact chain from the raw OpenIBIS index to the COEBIS value on
 * screen: pooled alignment, region correction and each patient-specific term,
 * with provenance and caveats.
 */
import { Sparkles } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCoebisModel } from "@/hooks/useCoebisModel";
import { explainCoebis } from "@/lib/eeg/coebis-explain";
import type { AdjunctCorrection } from "@/lib/eeg/coebis-adjuncts";
import type { KetamineSignature } from "@/lib/eeg/ketamine";
import type { CaseCovariates } from "@/lib/eeg/covariates";
import { cn } from "@/lib/utils";

export function CoebisExplainPanel({
  openIbis,
  covariates,
  adjunct,
  ketamine,
  className,
}: {
  openIbis: number | null | undefined;
  covariates: CaseCovariates | null | undefined;
  /** Entropy/PSI-informed adjunct applied to the live number, when present. */
  adjunct?: AdjunctCorrection | null;
  /** Ketamine recognition for the live epoch, when present. */
  ketamine?: KetamineSignature | null;
  className?: string;
}) {
  const model = useCoebisModel();
  const explanation = explainCoebis(openIbis, model, covariates, adjunct, ketamine);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Explain the COEBIS number"
          className={cn(
            "flex min-h-[36px] items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:text-foreground",
            className,
          )}
        >
          <Sparkles className="h-4 w-4" />
          <span>Why this number?</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem]">
        <p className="text-sm font-semibold">How COEBIS was derived</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{explanation.provenance}</p>

        {explanation.available ? (
          <>
            <ol className="mt-3 space-y-2">
              {explanation.steps.map((step, i) => (
                <li key={`${step.label}-${i}`} className="border-l-2 border-border pl-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">{step.label}</span>
                    <span className="metric-value text-xs text-muted-foreground">
                      {step.delta === 0
                        ? step.value.toFixed(1)
                        : `${step.delta > 0 ? "+" : "−"}${Math.abs(step.delta).toFixed(1)} → ${step.value.toFixed(1)}`}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{step.detail}</p>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-foreground">
              OpenIBIS {explanation.raw} → COEBIS{" "}
              <span className="metric-value font-semibold">{explanation.final}</span> (
              {explanation.netShift >= 0 ? "+" : "−"}
              {Math.abs(explanation.netShift).toFixed(1)} points)
            </p>
          </>
        ) : null}

        {explanation.caveats.length ? (
          <ul className="mt-3 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            {explanation.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
