import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withInterval } from "@/lib/eeg/ci";
import { getProspectiveReport, lockCoebisModel } from "@/lib/eeg/prospective.functions";
import { DiscriminationPanel } from "./DiscriminationPanel";

function num(v: number | null | undefined, dp = 1): string {
  return v == null ? "—" : v.toFixed(dp);
}

/**
 * Prospective validation: freeze a model, then score it only on readings taken
 * afterwards. This is the difference between "the model fits my data" and
 * "the model was right about the next patient".
 */
export function ProspectiveValidationPanel() {
  const [lockId, setLockId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const fetchReport = useServerFn(getProspectiveReport);
  const lockModel = useServerFn(lockCoebisModel);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-prospective", lockId],
    queryFn: () => fetchReport({ data: { lockId: lockId ?? undefined } }),
  });

  const lockMutation = useMutation({
    mutationFn: () => lockModel({ data: { label: label.trim() || undefined } }),
    onSuccess: (result) => {
      setLabel("");
      setLockId(result.id);
      toast.success("Model locked", {
        description: "Every paired reading from now on is unseen test data for this version.",
      });
      void queryClient.invalidateQueries({ queryKey: ["coebis-prospective"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not lock the model."),
  });

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Scoring readings taken since the lock…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="text-sm text-critical">
        {error instanceof Error ? error.message : "Could not build the prospective report."}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="panel p-3 text-sm">{data.summary}</p>

      <section className="panel p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Lock className="size-4 text-signal" /> Lock the current model
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Locking snapshots today's COEBIS coefficients. Readings you log afterwards are scored
          against those frozen numbers, so the agreement below cannot be flattered by refitting.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. “Autumn validation”"
            className="h-11 max-w-xs sm:h-9"
            aria-label="Lock label"
          />
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => lockMutation.mutate()}
            disabled={lockMutation.isPending}
          >
            {lockMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
            Lock current fit
          </Button>
        </div>
      </section>

      {data.locks.length > 0 && (
        <section className="panel p-3">
          <h3 className="mb-2 text-sm font-semibold">Locked versions</h3>
          <ul className="space-y-1 text-xs">
            {data.locks.map((lock) => (
              <li key={lock.id}>
                <button
                  type="button"
                  onClick={() => setLockId(lock.id)}
                  className={`flex w-full flex-wrap items-baseline gap-2 rounded-md px-2 py-2 text-left ${
                    lock.id === data.activeLockId ? "bg-signal/10" : "hover:bg-accent"
                  }`}
                >
                  <span className="font-medium">{lock.label}</span>
                  <span className="text-muted-foreground">
                    locked {new Date(lock.lockedAt).toLocaleDateString()} · v{lock.modelVersion ?? "?"} ·{" "}
                    {lock.trainingReadings} training, {lock.unseenReadings} unseen from{" "}
                    {lock.unseenCases} case{lock.unseenCases === 1 ? "" : "s"}
                    {lock.straddlingCases
                      ? ` · ${lock.straddlingCases} case${lock.straddlingCases === 1 ? "" : "s"} straddling the lock, counted as training`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.prospective && (
        <section className="panel p-3">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-signal" /> Agreement on unseen readings
          </h3>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground uppercase">Mean error</dt>
              <dd className="metric-value text-xl font-semibold">
                {withInterval(data.prospective.mae, data.maeCi)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground uppercase">Bias</dt>
              <dd className="metric-value text-xl font-semibold">
                {withInterval(data.prospective.bias, data.biasCi)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground uppercase">Within 5 points</dt>
              <dd className="metric-value text-xl font-semibold">
                {data.prospective.within5 ?? "—"}%
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground uppercase">Concordance</dt>
              <dd className="metric-value text-xl font-semibold">{data.prospective.ccc ?? "—"}</dd>
            </div>
          </dl>
          {data.baseline && (
            <p className="mt-2 text-xs text-muted-foreground">
              Raw open index on the same readings: {num(data.baseline.mae)} mean error,{" "}
              {num(data.baseline.bias)} bias. Confidence intervals are bootstrapped by case, so one
              long case cannot narrow them artificially.
            </p>
          )}
          {data.agreement?.limits && (
            <p className="mt-2 text-xs text-muted-foreground">
              Limits of agreement {data.agreement.limits[0].toFixed(1)} to{" "}
              {data.agreement.limits[1].toFixed(1)} points once repeated readings within a case are
              separated
              {data.agreement.naiveLimits
                ? ` (the classic pooled formula would claim ${data.agreement.naiveLimits[0].toFixed(1)} to ${data.agreement.naiveLimits[1].toFixed(1)})`
                : ""}
              .
            </p>
          )}
        </section>
      )}

      {data.discrimination && data.discrimination.indices.length > 0 && (
        <DiscriminationPanel
          report={data.discrimination}
          title="Discrimination on unseen patients"
        />
      )}

      {data.strata.length > 0 && (
        <section className="panel p-3">
          <h3 className="mb-2 text-sm font-semibold">Unseen error by subgroup</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Group</th>
                  <th className="py-1 text-right font-medium">Readings</th>
                  <th className="py-1 text-right font-medium">Mean error</th>
                  <th className="py-1 text-right font-medium">Bias</th>
                </tr>
              </thead>
              <tbody>
                {data.strata.map((s) => (
                  <tr key={`${s.group}-${s.level}`} className="border-t border-border/60">
                    <td className="py-1">
                      {s.group}: {s.level}
                    </td>
                    <td className="py-1 text-right tabular-nums">{s.n}</td>
                    <td className="py-1 text-right tabular-nums">{num(s.after.mae)}</td>
                    <td className="py-1 text-right tabular-nums">{num(s.after.bias)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
