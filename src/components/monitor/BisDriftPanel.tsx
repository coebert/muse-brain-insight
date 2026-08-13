import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { BisPairedChart } from "@/components/monitor/BisPairedChart";
import { BisBlandAltmanChart } from "@/components/monitor/BisBlandAltmanChart";
import { CoebisSufficiencyPanel } from "@/components/monitor/CoebisSufficiencyPanel";
import { syncBisAlignment } from "@/lib/eeg/bis-alignment";
import {
  clearBisAlignment,
  getBisDrift,
  reviewBisDrift,
  type BisDriftReview,
} from "@/lib/eeg/bis-drift.functions";
import { cn } from "@/lib/utils";

const VERDICT_TONE: Record<string, string> = {
  insufficient: "bg-muted text-muted-foreground",
  watching: "bg-caution/15 text-caution",
  provisional: "bg-caution/15 text-caution",
  aligned: "bg-signal/15 text-signal",
  adjust: "bg-caution/15 text-caution",
  adjustment_active: "bg-signal/15 text-signal",
};

const VERDICT_LABEL: Record<string, string> = {
  insufficient: "No data yet",
  watching: "Watching",
  provisional: "COEBIS provisional",
  aligned: "COEBIS tracking BIS",
  adjust: "COEBIS model fitted",
  adjustment_active: "COEBIS active",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="metric-value text-sm">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const signed = (v: number | null | undefined, dp = 1, suffix = "") =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${suffix}`;

/**
 * Cross-case surveillance of the open depth index against transcribed
 * commercial BIS values, and the automatic correction the app applies once the
 * offset is established across enough cases.
 */
export function BisDriftPanel() {
  const fetchDrift = useServerFn(getBisDrift);
  const clearAlignment = useServerFn(clearBisAlignment);
  const runReview = useServerFn(reviewBisDrift);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<BisDriftReview | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["bis-drift"],
    queryFn: async () => {
      const report = await fetchDrift({ data: undefined });
      // Keep the live estimator in step with whatever is now active.
      await syncBisAlignment();
      if (report.justApplied) {
        toast.success("Depth index re-aligned to your commercial BIS readings.");
      }
      return report;
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      await clearAlignment({ data: undefined });
      await syncBisAlignment();
    },
    onSuccess: () => {
      toast.success("COEBIS model removed — only the published OpenIBIS index is shown.");
      void queryClient.invalidateQueries({ queryKey: ["bis-drift"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!data) throw new Error("No drift data yet.");
      return runReview({
        data: { digest: { ...data.analysis, activeCorrection: data.active } },
      });
    },
    onSuccess: setReview,
    onError: (e: Error) => toast.error(e.message),
  });

  const a = data?.analysis;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <Activity className="h-4 w-4 text-signal" aria-hidden />
        <h2 className="text-sm font-semibold">COEBIS model / BIS drift watch (all cases)</h2>
        {a ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px]",
              VERDICT_TONE[a.verdict] ?? VERDICT_TONE["watching"],
            )}
          >
            {VERDICT_LABEL[a.verdict] ?? a.verdict}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={!a || a.n < 5 || reviewMutation.isPending}
          onClick={() => reviewMutation.mutate()}
        >
          {reviewMutation.isPending ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 size-3.5" />
          )}
          AI review
        </Button>
      </div>

      <div className="space-y-4 px-4 py-3">
        {isLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Pooling paired readings…
          </p>
        ) : error ? (
          <p className="text-xs text-critical">{(error as Error).message}</p>
        ) : a ? (
          <>
            <p className="text-xs">{a.summary}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Mean offset (app − BIS)"
                value={signed(a.bias)}
                hint={a.ci ? `95 % CI ${a.ci[0].toFixed(1)} to ${a.ci[1].toFixed(1)}` : undefined}
              />
              <Stat label="Mean abs. error" value={a.mae == null ? "—" : a.mae.toFixed(1)} />
              <Stat label="Pearson r" value={a.r == null ? "—" : a.r.toFixed(2)} />
              <Stat
                label="Paired readings"
                value={`${a.n}`}
                hint={`${a.sessions} case${a.sessions === 1 ? "" : "s"} · ${a.nReliable} reliable`}
              />
              <Stat label="Recent offset" value={signed(a.recent.bias)} hint={`last ${a.recent.n}`} />
              {a.bands.map((b) => (
                <Stat
                  key={b.band}
                  label={b.band}
                  value={b.n ? signed(b.bias) : "—"}
                  hint={b.n ? `n = ${b.n}` : "no readings"}
                />
              ))}
            </div>

            {a.verdict === "watching" || a.verdict === "insufficient" ? (
              <p className="text-[11px] text-muted-foreground">
                Progress to automatic adjustment: {a.readiness.points.have}/
                {a.readiness.points.need} paired readings, {a.readiness.sessions.have}/
                {a.readiness.sessions.need} cases.
              </p>
            ) : null}

            <CoebisSufficiencyPanel analysis={a} active={data?.active ?? null} />

            {data?.active ? (
              <div className="rounded-md border border-border px-3 py-2 text-xs">
                <p className="font-semibold">
                  Active COEBIS model — BIS ≈ {data.active.gain.toFixed(3)} × index{" "}
                  {data.active.offset >= 0 ? "+" : "−"} {Math.abs(data.active.offset).toFixed(1)}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Fitted {data.active.autoApplied ? "automatically" : "manually"} from{" "}
                  {data.active.nPoints} readings across {data.active.nSessions} cases on{" "}
                  {new Date(data.active.createdAt).toLocaleDateString()}. Mean absolute error{" "}
                  {data.active.maeBefore?.toFixed(1) ?? "—"} →{" "}
                  {data.active.maeAfter?.toFixed(1) ?? "—"} index points. Shown as the COEBIS tile; the OpenIBIS number is always displayed alongside it, unchanged.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5 h-8 px-2"
                  disabled={clearMutation.isPending}
                  onClick={() => clearMutation.mutate()}
                >
                  Remove COEBIS model
                </Button>
              </div>
            ) : a.fit ? (
              <p className="text-xs text-muted-foreground">
                Candidate correction: BIS ≈ {a.fit.gain.toFixed(3)} × index{" "}
                {a.fit.offset >= 0 ? "+" : "−"} {Math.abs(a.fit.offset).toFixed(1)} (mean absolute
                error {a.fit.maeBefore.toFixed(1)} → {a.fit.maeAfter.toFixed(1)}). It is applied
                automatically once the evidence thresholds above are met.
              </p>
            ) : null}

            <BisPairedChart series={data?.series ?? []} />

            <BisBlandAltmanChart series={data?.series ?? []} active={data?.active ?? null} />

            {review ? (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-sm font-semibold">{review.headline}</p>
                <p className="text-xs">{review.reading}</p>
                {review.recommendation ? (
                  <div>
                    <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                      Recommendation
                    </p>
                    <p className="text-xs">{review.recommendation}</p>
                  </div>
                ) : null}
                {review.cautions.length ? (
                  <p className="text-[11px] text-muted-foreground">
                    Cautions: {review.cautions.join(" · ")}
                  </p>
                ) : null}
              </div>
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              BIS is a proprietary index; this is trend alignment against your transcribed
              readings, never a validation or a substitute for the commercial monitor.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
