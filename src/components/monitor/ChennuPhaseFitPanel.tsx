import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Waypoints } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { runChennuPhases } from "@/lib/eeg/coebis-chennu-phases.functions";
import { PHASE_ORDER, PHASE_TEXT } from "@/lib/eeg/coebis-chennu-phases.server";

const dp = (v: number | null | undefined, places = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(places);
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;
const signed = (v: number | null) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

/**
 * COEBIS across the Cambridge propofol arc, phase by phase.
 *
 * The volunteers were recorded in four stepped blocks, which stand in for
 * baseline, induction, maintenance and emergence. The grade is direction
 * within each volunteer, never agreement with a monitor: these are
 * high-density scalp recordings of sedation, not theatre headband signal.
 */
export function ChennuPhaseFitPanel() {
  const run = useServerFn(runChennuPhases);
  const job = useMutation({
    mutationFn: () => run({ data: undefined }),
    onError: (e: Error) => toast.error(e.message),
    onSuccess: (r) =>
      r.epochs
        ? toast.success(`Scored ${r.epochs.toLocaleString()} readings across ${r.cases} people.`)
        : toast.warning("No Cambridge propofol recordings are stored yet."),
  });
  const r = job.data;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Waypoints className="size-4 text-signal" aria-hidden />
            Phase fit — COEBIS across the Cambridge arc
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            The volunteers were taken up through stepped propofol targets and back out
            again, so their blocks stand in for baseline, induction, maintenance and
            emergence. The only question asked here is direction: within one person, does
            the index fall as the drug rises and come back up on recovery? These are
            full-scalp sedation recordings, not theatre signal, so nothing is promoted.
          </p>
        </div>
        <Button size="sm" onClick={() => job.mutate()} disabled={job.isPending}>
          {job.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Run phase fit
        </Button>
      </header>

      {job.isPending ? (
        <p className="text-xs text-muted-foreground">Scoring each block…</p>
      ) : !r ? null : r.epochs === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing stored from this collection yet. Import it on the Data exchange tab first.
        </p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Readings", r.epochs.toLocaleString()],
              ["People", String(r.cases)],
              [
                "Deepened as drug rose",
                `${r.deepenedCount}/${r.comparableCount}`,
              ],
              ["Came back on recovery", `${r.recoveredCount}/${r.cases}`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md border border-border/60 bg-background/40 p-2">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Phase</th>
                  <th className="py-1 pr-3 font-medium">Readings</th>
                  <th className="py-1 pr-3 font-medium">Mean index</th>
                  <th className="py-1 pr-3 font-medium">Spread</th>
                  <th className="py-1 pr-3 font-medium">Range</th>
                  <th className="py-1 pr-3 font-medium">Below 60</th>
                  <th className="py-1 font-medium">Not answering</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {r.byPhase.map((p) => (
                  <tr key={p.phase} className="border-t border-border/50">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">{p.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{p.detail}</span>
                    </td>
                    <td className="py-1.5 pr-3">{p.epochs.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 font-semibold text-signal">{dp(p.meanIndex)}</td>
                    <td className="py-1.5 pr-3">±{dp(p.sdIndex)}</td>
                    <td className="py-1.5 pr-3">
                      {dp(p.minIndex, 0)}–{dp(p.maxIndex, 0)}
                    </td>
                    <td className="py-1.5 pr-3">{pct(p.belowSixty)}</td>
                    <td className="py-1.5">{pct(p.unresponsiveShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="rounded-md border border-border/60 bg-background/40 p-3">
            <summary className="cursor-pointer text-xs font-medium">
              Each person's arc ({r.arcs.length})
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Person</th>
                    {PHASE_ORDER.map((p) => (
                      <th key={p} className="py-1 pr-3 font-medium">
                        {PHASE_TEXT[p].label}
                      </th>
                    ))}
                    <th className="py-1 pr-3 font-medium">Deepening</th>
                    <th className="py-1 font-medium">Recovery</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {r.arcs.map((a) => (
                    <tr key={a.caseRef} className="border-t border-border/50">
                      <td className="py-1.5 pr-3 font-medium">{a.caseRef}</td>
                      {PHASE_ORDER.map((p) => (
                        <td key={p} className="py-1.5 pr-3">
                          {dp(a.phases[p])}
                        </td>
                      ))}
                      <td
                        className={`py-1.5 pr-3 ${(a.deepening ?? 0) < 0 ? "text-signal" : "text-muted-foreground"}`}
                      >
                        {signed(a.deepening)}
                      </td>
                      <td
                        className={`py-1.5 ${(a.recovery ?? 0) > 0 ? "text-signal" : "text-muted-foreground"}`}
                      >
                        {signed(a.recovery)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <p className="text-[11px] text-muted-foreground">
            Read-out only — no model was changed. Deepest block here is moderate sedation, so
            nothing on this page speaks to surgical depth or suppression.
            {r.truncated ? " Reading was capped, so later blocks may be missing." : ""}
          </p>
        </div>
      )}
    </section>
  );
}
