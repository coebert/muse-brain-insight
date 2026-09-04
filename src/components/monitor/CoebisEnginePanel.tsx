import { COEBIS_V2_MODEL } from "@/lib/eeg/coebis-v2";

/**
 * What the COEBIS-2 engine is, and how far it is from the bedside monitor on
 * patients it never saw. Nothing here is a live reading — these are the
 * cross-validated numbers from the fit, shown so the index is never read
 * without its error bar.
 */
export function CoebisEnginePanel() {
  const m = COEBIS_V2_MODEL.meta;
  const gain = m.baselineMae - m.heldOutMae;
  const stat = (label: string, value: string, note: string) => (
    <div className="panel p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );

  return (
    <div className="space-y-3">
      <section className="panel p-3">
        <h3 className="text-sm font-semibold">COEBIS-2: fitted from raw EEG</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The original index is the published OpenIBIS calculation with a
          calibration bolted on top, so tuning could only shift the answer up or
          down. COEBIS-2 replaces the calculation itself: every term was fitted
          on simultaneous bedside EEG and BIS, and graded by holding whole
          patients out of the fit, so no coefficient was ever scored on a
          patient it learned from.
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        {stat(
          "Average gap to the monitor",
          m.heldOutMae.toFixed(2),
          `points, on ${m.cases} held-out patients`,
        )}
        {stat(
          "Against the old engine",
          `${gain > 0 ? "−" : "+"}${Math.abs(gain).toFixed(2)}`,
          `points; OpenIBIS scored ${m.baselineMae.toFixed(2)} on the same readings`,
        )}
        {stat(
          "Within 5 points",
          `${m.heldOutWithin5.toFixed(1)}%`,
          `of ${m.rows.toLocaleString()} paired readings`,
        )}
      </div>

      <section className="panel p-3 text-xs text-muted-foreground">
        <div>
          Fitted on <span className="font-mono">{m.lineage}</span> ({m.fittedAt}).
          These figures belong to that recording setup only. On a different
          montage or sample rate the index still computes, but this error bar
          does not carry over and the reading is labelled as an extrapolation.
        </div>
        <div className="mt-2">
          COEBIS-2 is trained to agree with a BIS monitor. Agreement is not
          proof of depth: both can be wrong together, and neither replaces
          clinical assessment.
        </div>
      </section>
    </div>
  );
}
