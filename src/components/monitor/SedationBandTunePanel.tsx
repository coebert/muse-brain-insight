import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sliders } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { runSedationBandTune } from "@/lib/eeg/coebis-sedation-bands.functions";

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(0)}%`;
const num = (v: number | null | undefined, places = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(places);

/**
 * Tune where the COEBIS number sits for each sedation state.
 *
 * The curve is monotone, so it changes the scale, never the ordering: it
 * cannot make the index better or worse at telling states apart, only better
 * at putting them in the band a clinician reads them in. It is adopted only
 * if held-out placement improves and agreement with the bedside monitor is
 * not spent to buy it.
 */
export function SedationBandTunePanel() {
  const run = useServerFn(runSedationBandTune);
  const job = useMutation({
    mutationFn: () => run({ data: undefined }),
    onError: (e: Error) => toast.error(e.message),
    onSuccess: (r) =>
      r.promoted
        ? toast.success("Tuned scale adopted.")
        : toast.warning(r.reason || "Nothing adopted."),
  });
  const r = job.data;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Sliders className="size-4 text-signal" aria-hidden />
            Sedation band tuning
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Fits where the index should sit for awake, light sedation and unresponsive states
            using the Chennu and DOSE-I labels, holding whole cases out. The curve only moves
            readings up or down the scale — it never reorders them — and is adopted only if it
            also keeps agreement with your stored bedside BIS readings.
          </p>
        </div>
        <Button size="sm" onClick={() => job.mutate()} disabled={job.isPending}>
          {job.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Tune the scale
        </Button>
      </header>

      {job.isPending ? (
        <p className="text-xs text-muted-foreground">Reading labelled epochs and fitting…</p>
      ) : !r ? null : r.epochs === 0 ? (
        <p className="text-xs text-muted-foreground">
          No labelled sedation epochs stored yet. Import a collection on the Data exchange tab
          first.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {r.epochs.toLocaleString()} labelled readings across {r.cases} cases, {r.folds}{" "}
            whole-case folds.
            {r.truncated ? " Read capped at the epoch ceiling." : ""}
          </p>

          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1">State</th>
                <th className="py-1 text-right">Readings</th>
                <th className="py-1 text-right">Mean now</th>
                <th className="py-1 text-right">Mean tuned</th>
                <th className="py-1 text-right">In band now</th>
                <th className="py-1 text-right">In band tuned</th>
              </tr>
            </thead>
            <tbody>
              {r.heldOut.map((g) => (
                <tr key={g.band} className="border-t border-border/50">
                  <td className="py-1">{g.label}</td>
                  <td className="py-1 text-right tabular-nums">{g.epochs.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums">{num(g.meanBefore)}</td>
                  <td className="py-1 text-right tabular-nums">{num(g.meanAfter)}</td>
                  <td className="py-1 text-right tabular-nums">{pct(g.inBandBefore)}</td>
                  <td className="py-1 text-right tabular-nums">{pct(g.inBandAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-muted-foreground">
            Held-out figures: every case is scored by a curve fitted without it. Overall band
            placement {pct(r.inBandBefore)} → {pct(r.inBandAfter)}.
          </p>

          {r.bis ? (
            <p className="text-xs">
              Against {r.bis.points.toLocaleString()} stored bedside monitor readings, average
              disagreement {num(r.bis.maeBefore, 2)} → {num(r.bis.maeAfter, 2)} points.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No stored bedside monitor pairs to check the curve against.
            </p>
          )}

          <p
            className={`text-xs ${r.promoted ? "text-signal" : "text-muted-foreground"}`}
            role="status"
          >
            {r.promoted ? "Adopted. " : "Not adopted. "}
            {r.reason}
          </p>

          <p className="text-[11px] text-muted-foreground">
            Curve: {r.knots.map((k, i) => `${k}→${num(r.tune.outputs[i])}`).join(", ")}. Below 40
            is left for burst suppression, which none of these recordings label.
          </p>
        </div>
      )}
    </section>
  );
}
