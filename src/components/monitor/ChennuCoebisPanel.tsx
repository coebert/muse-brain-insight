import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { runCoebisOnChennu } from "@/lib/eeg/coebis-chennu.functions";

const dp = (v: number | null | undefined, places = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(places);
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;

/**
 * COEBIS read on the Cambridge propofol volunteers.
 *
 * Those recordings kept their spectra, not their waveform, so the index is
 * rebuilt from each stored spectrum with the amplitude terms reconstructed
 * from the integrated power. The montage is high-density scalp, not the
 * frontal lineage the fit was trained on, so the reading is an extrapolation
 * and is labelled as one.
 */
export function ChennuCoebisPanel() {
  const run = useServerFn(runCoebisOnChennu);
  const job = useMutation({
    mutationFn: () => run({ data: undefined }),
    onError: (e: Error) => toast.error(e.message),
    onSuccess: (r) =>
      r.epochsScored
        ? toast.success(`Scored ${r.epochsScored.toLocaleString()} epochs.`)
        : toast.warning("No Cambridge propofol epochs are stored yet."),
  });
  const r = job.data;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="size-4 text-signal" aria-hidden />
            COEBIS on the Cambridge propofol recordings
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Runs the index over every stored epoch of the Chennu volunteer study and reports
            what it read at each sedation level. The study recorded whether the volunteer
            answered, not a monitor number, so the only grade here is separation: does the
            index sit high while they responded and low while they did not?
          </p>
        </div>
        <Button size="sm" onClick={() => job.mutate()} disabled={job.isPending}>
          {job.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Run COEBIS
        </Button>
      </header>

      {job.isPending ? (
        <p className="text-xs text-muted-foreground">Scoring the stored epochs…</p>
      ) : !r ? null : r.epochsScored === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing stored from this collection yet. Import it on the Data exchange tab first.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="rounded-md border border-caution/40 bg-caution/5 p-2 text-xs text-muted-foreground">
            {r.applicability === "fitted"
              ? "Read on the lineage the model was fitted to."
              : "Extrapolated reading: this is a 91-channel scalp montage, not the frontal lineage the model was fitted on. Treat the numbers as a separation check, not as an accuracy claim."}
          </p>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <p>
              Epochs scored <span className="font-mono">{r.epochsScored.toLocaleString()}</span>
            </p>
            <p>
              Volunteers <span className="font-mono">{r.cases}</span>
            </p>
            <p>
              Separation <span className="font-mono">{dp(r.separation.auc, 3)}</span>
            </p>
            <p>
              Gap <span className="font-mono">{dp(r.separation.gap)}</span> points
            </p>
            <p>
              Responding average{" "}
              <span className="font-mono">{dp(r.separation.meanResponsive)}</span>
            </p>
            <p>
              Not responding average{" "}
              <span className="font-mono">{dp(r.separation.meanUnresponsive)}</span>
            </p>
            <p>
              On the wrong side <span className="font-mono">{pct(r.separation.overlap)}</span>
            </p>
            <p>
              Labels not usable <span className="font-mono">{r.unusable.toLocaleString()}</span>
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-medium">Recorded state</th>
                  <th className="py-1 pr-3 font-medium">Epochs</th>
                  <th className="py-1 pr-3 font-medium">Mean index</th>
                  <th className="py-1 pr-3 font-medium">Range</th>
                  <th className="py-1 font-medium">Below 60</th>
                </tr>
              </thead>
              <tbody>
                {r.byLabel.map((l) => (
                  <tr key={l.label} className="border-t border-border/50">
                    <td className="py-1 pr-3">{l.label.replace(/_/g, " ")}</td>
                    <td className="py-1 pr-3 font-mono">{l.epochs.toLocaleString()}</td>
                    <td className="py-1 pr-3 font-mono">{dp(l.meanIndex)}</td>
                    <td className="py-1 pr-3 font-mono">
                      {l.minIndex}–{l.maxIndex}
                    </td>
                    <td className="py-1 font-mono">{pct(l.belowSixty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Per volunteer ({r.byCase.length})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-3 font-medium">Volunteer</th>
                    <th className="py-1 pr-3 font-medium">Epochs</th>
                    <th className="py-1 pr-3 font-medium">Mean</th>
                    <th className="py-1 pr-3 font-medium">Responding</th>
                    <th className="py-1 font-medium">Not responding</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byCase.map((c) => (
                    <tr key={c.caseRef} className="border-t border-border/50">
                      <td className="py-1 pr-3">{c.caseRef}</td>
                      <td className="py-1 pr-3 font-mono">{c.epochs.toLocaleString()}</td>
                      <td className="py-1 pr-3 font-mono">{dp(c.meanIndex)}</td>
                      <td className="py-1 pr-3 font-mono">{dp(c.meanResponsive)}</td>
                      <td className="py-1 font-mono">{dp(c.meanUnresponsive)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {r.truncated ? (
            <p className="text-xs text-muted-foreground">
              Read capped at {r.epochsScanned.toLocaleString()} epochs for this pass.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
