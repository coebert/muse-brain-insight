import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, GitBranch } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getRefitOverview, runRefitNow } from "@/lib/eeg/coebis-refit.functions";
import { cn } from "@/lib/utils";

const signed = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
const plain = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);

/**
 * Scheduled COEBIS refit pipeline: what the nightly job did, which model
 * version is live per acquisition lineage, and the held-out performance of the
 * candidate against the model it was compared with.
 */
export function RefitPipelinePanel() {
  const fetchOverview = useServerFn(getRefitOverview);
  const runNow = useServerFn(runRefitNow);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-refit-overview"],
    queryFn: () => fetchOverview(),
    staleTime: 30_000,
  });

  const refit = useMutation({
    mutationFn: () => runNow(),
    onSuccess: (result) => {
      if (result.status === "failed") toast.error(result.error ?? "Refit failed");
      else toast.success(result.summary || "Refit complete");
      void queryClient.invalidateQueries({ queryKey: ["coebis-refit-overview"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Model refit pipeline
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refit.mutate()}
            disabled={refit.isPending}
          >
            {refit.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Refit now
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        The scheduled job refits COEBIS per acquisition lineage on newly validated readings, scores
        the candidate leave-one-case-out against the model currently in force, and only promotes it
        when held-out error clearly improves. Every candidate is versioned either way.
      </p>

      {error ? <p className="mt-3 text-xs text-critical">{(error as Error).message}</p> : null}

      {data ? (
        <>
          <div className="mt-3 space-y-2">
            {data.lineages.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No model versions yet — the pipeline needs validated paired readings across at least
                three cases in one lineage.
              </p>
            ) : (
              data.lineages.map((l) => (
                <div key={l.lineageKey} className="rounded-md border border-border/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-foreground">{l.lineageKey}</p>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px]",
                        l.activeVersion
                          ? "bg-signal/15 text-signal"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {l.activeVersion ? `v${l.activeVersion} live` : "no promoted version"}
                    </span>
                  </div>
                  {l.latest ? (
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div className="rounded bg-muted/40 px-2 py-1.5">
                        <p className="text-[11px] uppercase text-muted-foreground">Before MAE</p>
                        <p className="metric-value text-sm">{plain(l.latest.before.mae)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {l.latest.before.source === "raw_index" ? "raw index" : "previous model"}
                        </p>
                      </div>
                      <div className="rounded bg-muted/40 px-2 py-1.5">
                        <p className="text-[11px] uppercase text-muted-foreground">After MAE</p>
                        <p className="metric-value text-sm">{plain(l.latest.after.mae)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          held out, {l.latest.training.folds ?? 0} folds
                        </p>
                      </div>
                      <div className="rounded bg-muted/40 px-2 py-1.5">
                        <p className="text-[11px] uppercase text-muted-foreground">Bias</p>
                        <p className="metric-value text-sm">
                          {signed(l.latest.before.bias, 1)} → {signed(l.latest.after.bias, 1)}
                        </p>
                      </div>
                      <div className="rounded bg-muted/40 px-2 py-1.5">
                        <p className="text-[11px] uppercase text-muted-foreground">Gain</p>
                        <p className="metric-value text-sm">{signed(l.latest.maeGain)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {l.latest.training.n ?? 0} readings / {l.latest.training.cases ?? 0} cases
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {l.latest?.reason ? (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">{l.latest.reason}</p>
                  ) : null}
                  {l.versions.length > 1 ? (
                    <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                      {l.versions.slice(1, 5).map((v) => (
                        <li key={v.id}>
                          v{v.version} · {new Date(v.createdAt).toLocaleString()} · MAE{" "}
                          {plain(v.before.mae)} → {plain(v.after.mae)} ·{" "}
                          {v.promoted ? "promoted" : "kept as candidate"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {data.runs.length ? (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Recent runs
              </p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {data.runs.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    <span className="text-foreground">
                      {new Date(r.startedAt).toLocaleString()}
                    </span>{" "}
                    · {r.trigger} · {r.status} · {r.validatedPoints} validated readings ·{" "}
                    {r.summary ?? r.error ?? ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
