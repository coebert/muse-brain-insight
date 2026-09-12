import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Brain, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getStatePool, runStateLabelFit } from "@/lib/eeg/state-labels.functions";
import {
  MIN_AUC,
  MIN_AUC_GAIN,
  MIN_CASES,
  MIN_EPOCHS,
  MIN_PER_STATE,
  type Separation,
} from "@/lib/eeg/state-labels";

const dp = (v: number | null | undefined, places = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(places);
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;

function SeparationRow({ title, s }: { title: string; s: Separation }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <p>
          Separation <span className="font-mono">{dp(s.auc, 3)}</span>
        </p>
        <p>
          Responsive average <span className="font-mono">{dp(s.meanResponsive)}</span>
        </p>
        <p>
          Unresponsive average <span className="font-mono">{dp(s.meanUnresponsive)}</span>
        </p>
        <p>
          Gap <span className="font-mono">{dp(s.gap)}</span> points
        </p>
        <p>
          Cut-point <span className="font-mono">{s.cut ? s.cut.index : "—"}</span>
        </p>
        <p>
          Sensitivity <span className="font-mono">{s.cut ? pct(s.cut.sensitivity) : "—"}</span>
        </p>
        <p>
          Specificity <span className="font-mono">{s.cut ? pct(s.cut.specificity) : "—"}</span>
        </p>
        <p>
          On the wrong side <span className="font-mono">{pct(s.overlap)}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Conscious / unconscious labels as a depth target.
 *
 * The PhysioNet power-spectra collection records a state word rather than a
 * monitor number, so those epochs are used to grade how cleanly the index
 * tells a responsive patient from an unresponsive one. Everything shown is
 * held out by case, and a candidate only takes over on a clear gain.
 */
export function StateLabelPanel() {
  const fetchPool = useServerFn(getStatePool);
  const runFit = useServerFn(runStateLabelFit);
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<string>("");

  const pool = useQuery({
    queryKey: ["state-label-pool"],
    queryFn: () => fetchPool({ data: { lineage: null } }),
    staleTime: 30_000,
  });

  const fit = useMutation({
    mutationFn: () => runFit({ data: { lineage: scope || null } }),
    onSuccess: (r) => {
      if (r.promoted) toast.success(`Promoted version ${r.version}. ${r.reason}`);
      else toast.warning(r.reason || "Nothing was promoted; the model in force is unchanged.");
      queryClient.invalidateQueries({ queryKey: ["state-label-pool"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = pool.data;
  const scopeKeys = scope.split(",").map((s) => s.trim()).filter(Boolean);
  const parts = (data?.lineages ?? []).filter((l) => scopeKeys.includes(l.lineage));
  const combined = scopeKeys.length > 1;
  const selected =
    parts.length === 0
      ? null
      : combined
        ? {
            lineage: parts.map((p) => p.lineage).join(" + "),
            epochs: parts.reduce((n, p) => n + p.epochs, 0),
            cases: parts.reduce((n, p) => n + p.cases, 0),
            responsive: parts.reduce((n, p) => n + p.responsive, 0),
            unresponsive: parts.reduce((n, p) => n + p.unresponsive, 0),
            labels: [...parts.flatMap((p) => p.labels).reduce((m, l) => {
              m.set(l.label, (m.get(l.label) ?? 0) + l.count);
              return m;
            }, new Map<string, number>())]
              .map(([label, count]) => ({ label, count }))
              .sort((a, b) => b.count - a.count),
            separation: null,
          }
        : { ...parts[0]!, separation: parts[0]!.separation as Separation | null };
  const counts = selected ?? data;
  const enough =
    !!counts &&
    counts.epochs >= MIN_EPOCHS &&
    counts.cases >= MIN_CASES &&
    counts.responsive >= MIN_PER_STATE &&
    counts.unresponsive >= MIN_PER_STATE;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Brain className="size-4 text-signal" aria-hidden />
            Conscious / unconscious labels
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            These recordings carry a state word, not a monitor number, so they are not turned
            into invented depth scores. They grade one thing instead: how cleanly the index
            separates a responsive patient from an unresponsive one. Upload the files on the
            Data exchange tab; every figure below is held out by case.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Which collection to fit on"
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              fit.reset();
            }}
          >
            <option value="">All labelled collections</option>
            {(data?.lineages ?? []).map((l) => (
              <option key={l.lineage} value={l.lineage}>
                {l.lineage}
              </option>
            ))}
          </select>
        <Button
          size="sm"
          onClick={() => fit.mutate()}
          disabled={fit.isPending || !enough}
          title={enough ? undefined : "Not enough labelled epochs yet"}
        >
          {fit.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Run fit
        </Button>
        </div>
      </header>

      {pool.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading the labelled pool…</p>
      ) : pool.error ? (
        <p className="text-xs text-critical">{(pool.error as Error).message}</p>
      ) : !data || data.epochs === 0 ? (
        <p className="text-xs text-muted-foreground">
          No labelled epochs yet. Any collection whose published labels name an awake or an
          anaesthetised patient — PhysioNet <code>eeg-power-anesthesia</code>, Chennu, DOSE-I,
          ds004541 — appears here once uploaded on the Data exchange tab.
        </p>

      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <p>
              Labelled epochs <span className="font-mono">{data.epochs.toLocaleString()}</span>
            </p>
            <p>
              Cases <span className="font-mono">{data.cases}</span>
            </p>
            <p>
              Responsive <span className="font-mono">{data.responsive.toLocaleString()}</span>
            </p>
            <p>
              Unresponsive <span className="font-mono">{data.unresponsive.toLocaleString()}</span>
            </p>
          </div>

          {data.lineages.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">Where the labels come from</p>
              {data.lineages.map((l) => (
                <p key={l.lineage} className="text-xs text-muted-foreground">
                  <span className="font-mono">{l.lineage}</span> —{" "}
                  {l.epochs.toLocaleString()} epochs, {l.cases} cases,{" "}
                  {l.responsive.toLocaleString()} responsive /{" "}
                  {l.unresponsive.toLocaleString()} unresponsive, separation{" "}
                  <span className="font-mono">{dp(l.separation.auc, 3)}</span>
                </p>
              ))}
            </div>
          ) : null}

          {data.unusable > 0 ? (
            <p className="text-xs text-muted-foreground">
              {data.unusable.toLocaleString()} epochs were set aside: their label sits between the
              two states (for example “sedated”), where patients both do and do not respond.
            </p>
          ) : null}


          {selected ? (
            <div className="space-y-2 rounded-md border border-signal/40 bg-signal/5 p-3">
              <p className="text-xs font-medium">
                Scored against this collection&rsquo;s own labels
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                {selected.labels.map((l) => (
                  <p key={l.label}>
                    <span className="font-mono">{l.label}</span>{" "}
                    {l.count.toLocaleString()}
                  </p>
                ))}
              </div>
              <SeparationRow
                title={`${selected.lineage} — index in force today`}
                s={selected.separation}
              />
            </div>
          ) : null}

          <SeparationRow
            title={
              data.activeVersion
                ? `In force today — fitted version ${data.activeVersion}`
                : "In force today — reference mapping"
            }
            s={data.current}
          />

          {fit.data ? (
            <>
              <SeparationRow title="Reference, held out by case" s={fit.data.before} />
              <SeparationRow title="Candidate, held out by case" s={fit.data.after} />
              <p className="text-xs text-muted-foreground">
                {fit.data.promoted ? "Promoted. " : "Not promoted. "}
                {fit.data.reason} A candidate has to gain at least{" "}
                {MIN_AUC_GAIN.toFixed(2)} and reach {MIN_AUC.toFixed(2)} before it takes over.
              </p>
            </>
          ) : !enough ? (
            <p className="text-xs text-muted-foreground">
              A fit needs {MIN_EPOCHS} labelled epochs across {MIN_CASES} cases, with at least{" "}
              {MIN_PER_STATE} in each state.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
