import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { GitCompare, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { runStateModelComparison } from "@/lib/eeg/state-comparison.functions";

const dp = (v: number | null | undefined, places = 3) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(places);

const LINEAGE_TEXT: Record<string, string> = {
  "external:cambridge:chennu-propofol-sedation": "Cambridge propofol volunteers",
  "external:zenodo:dose-i": "DOSE-I sedation",
};

/**
 * Small state models graded beside COEBIS on the same sedation epochs.
 *
 * The small models are fitted on these recordings with whole-case folds;
 * COEBIS was fitted elsewhere entirely. The per-collection figures are the
 * ones to read: pooled across two very different collections, separation is
 * flattered by the difference between the datasets themselves.
 */
export function SimpleStateModelPanel() {
  const run = useServerFn(runStateModelComparison);
  const job = useMutation({
    mutationFn: () => run({ data: undefined }),
    onError: (e: Error) => toast.error(e.message),
    onSuccess: (r) =>
      r.epochs
        ? toast.success(`Graded ${r.epochs.toLocaleString()} labelled epochs.`)
        : toast.warning("No labelled sedation epochs are stored yet."),
  });
  const r = job.data;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <GitCompare className="size-4 text-signal" aria-hidden />
            Simple state models against COEBIS
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Fits one- and two-descriptor rules on the Chennu and DOSE-I sedation labels, holding
            whole cases out, and reads COEBIS on exactly the same epochs. Nothing here is
            promoted: it answers whether the full model earns its complexity.
          </p>
        </div>
        <Button size="sm" onClick={() => job.mutate()} disabled={job.isPending}>
          {job.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Run comparison
        </Button>
      </header>

      {job.isPending ? (
        <p className="text-xs text-muted-foreground">Fitting and grading…</p>
      ) : !r ? null : r.epochs === 0 ? (
        <p className="text-xs text-muted-foreground">
          No labelled sedation epochs stored yet. Import a collection on the Data exchange tab
          first.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {r.epochs.toLocaleString()} labelled epochs across {r.cases} cases (
            {r.responsive.toLocaleString()} responsive, {r.unresponsive.toLocaleString()}{" "}
            unresponsive), {r.folds} whole-case folds.
            {r.truncated ? " Read capped at the epoch ceiling." : ""}
          </p>

          <div>
            <h4 className="text-xs font-semibold">Per collection — the figure to trust</h4>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Within one collection, both models are judged on the same patients and the same
              montage.
            </p>
            <table className="mt-2 w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 font-medium">Collection</th>
                  <th className="py-1 font-medium">Epochs</th>
                  <th className="py-1 font-medium">COEBIS</th>
                  <th className="py-1 font-medium">Best simple rule</th>
                </tr>
              </thead>
              <tbody>
                {r.byLineage.map((l) => (
                  <tr key={l.lineage} className="border-t border-border/60">
                    <td className="py-1">{LINEAGE_TEXT[l.lineage] ?? l.lineage}</td>
                    <td className="py-1 tabular-nums">
                      {l.epochs.toLocaleString()} / {l.cases} cases
                    </td>
                    <td className="py-1 tabular-nums">{dp(l.coebisAuc)}</td>
                    <td className="py-1 tabular-nums">
                      {l.bestSimpleAuc == null ? "—" : `${dp(l.bestSimpleAuc)} (${l.bestSimpleKey})`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h4 className="text-xs font-semibold">Pooled across both collections</h4>
            <ul className="mt-2 space-y-1 text-xs">
              <li className="flex justify-between gap-3">
                <span>COEBIS (fitted elsewhere, unseen here)</span>
                <span className="tabular-nums">{dp(r.coebis.auc)}</span>
              </li>
              <li className="flex justify-between gap-3">
                <span>Reference mapping</span>
                <span className="tabular-nums">{dp(r.reference.auc)}</span>
              </li>
              <li className="flex justify-between gap-3">
                <span>Six-descriptor fit, held out</span>
                <span className="tabular-nums">{dp(r.full.auc)}</span>
              </li>
            </ul>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Pooled separation mixes two populations recorded on different equipment, so part of
              it is the gap between the collections rather than between the states.
            </p>
          </div>

          <div>
            <h4 className="text-xs font-semibold">Simple candidates, held out by case</h4>
            <table className="mt-2 w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 font-medium">Rule</th>
                  <th className="py-1 font-medium">Terms</th>
                  <th className="py-1 font-medium">Separation</th>
                  <th className="py-1 font-medium">Gap</th>
                </tr>
              </thead>
              <tbody>
                {r.simple.map((s) => (
                  <tr key={s.key} className="border-t border-border/60">
                    <td className="py-1">{s.label}</td>
                    <td className="py-1 tabular-nums">{s.terms}</td>
                    <td className="py-1 tabular-nums">{dp(s.separation.auc)}</td>
                    <td className="py-1 tabular-nums">{s.separation.gap.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
