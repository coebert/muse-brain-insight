import { Gauge, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/eeg/format";
import type { BisComparisonDigest } from "@/lib/eeg/bis";
import type { BisAgreementReport } from "@/lib/eeg/bis-agreement.functions";
import { cn } from "@/lib/utils";

const CONFIDENCE_TONE: Record<string, string> = {
  high: "bg-critical/15 text-critical",
  moderate: "bg-caution/15 text-caution",
  low: "bg-muted text-muted-foreground",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-2">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={cn("metric-value text-sm", tone)}>{value}</p>
    </div>
  );
}

function num(v: number | null | undefined, dp = 1, suffix = ""): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(dp)}${suffix}`;
}

/**
 * How the app's open depth index compares with the commercial BIS values the
 * clinician transcribed during the case: locally computed agreement statistics
 * plus an AI reading of where the open model diverges and how it could be
 * finessed.
 */
export function BisAgreementPanel({
  digest,
  report,
  loading,
  error,
  onRun,
}: {
  digest: BisComparisonDigest;
  report: BisAgreementReport | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const m = digest.metrics;
  const canRun = !digest.sparse;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <Gauge className="h-4 w-4 text-signal" aria-hidden />
        <h2 className="text-sm font-semibold">BIS reference agreement</h2>
        <span className="text-xs text-muted-foreground">
          {digest.paired} paired of {digest.readings} reading
          {digest.readings === 1 ? "" : "s"}
          {digest.unpaired ? ` · ${digest.unpaired} without EEG` : ""}
          {digest.devices.length ? ` · ${digest.devices.join(", ")}` : ""}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={!canRun || loading}
          onClick={onRun}
        >
          {loading ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 size-3.5" />
          )}
          AI comparison
        </Button>
      </div>

      <div className="space-y-4 px-4 py-3">
        {digest.readings === 0 ? (
          <p className="text-xs text-muted-foreground">
            Log values from the commercial BIS monitor during the case and this panel will compare
            them with the app's own depth index and suppression ratio.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Bias (app − BIS)" value={num(m?.bias ?? null, 1)} />
              <Stat
                label="95 % limits"
                value={
                  m && m.n >= 3
                    ? `${m.loaLower.toFixed(1)} to ${m.loaUpper.toFixed(1)}`
                    : "—"
                }
              />
              <Stat label="Pearson r" value={num(m?.r ?? null, 2)} />
              <Stat label="Lin's CCC" value={num(m?.ccc ?? null, 2)} />
              <Stat label="Mean abs. error" value={num(m?.mae ?? null, 1)} />
              <Stat label="Within 5" value={m && m.n >= 3 ? `${m.within5.toFixed(0)} %` : "—"} />
              <Stat label="Within 10" value={m && m.n >= 3 ? `${m.within10.toFixed(0)} %` : "—"} />
              <Stat
                label="SR bias (app − BIS)"
                value={digest.suppression.n ? num(digest.suppression.bias, 1, " %") : "—"}
              />
              <Stat
                label="SEF bias (app − BIS)"
                value={digest.sef.n ? num(digest.sef.bias, 1, " Hz") : "—"}
              />
            </div>

            <div>
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Bias by depth band
              </p>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                {digest.bands.map((b) => (
                  <div key={b.band} className="rounded-md bg-muted/40 px-2.5 py-2 text-xs">
                    <p className="text-muted-foreground">{b.band}</p>
                    <p className="metric-value text-sm">
                      {b.n ? `${(b.bias ?? 0) > 0 ? "+" : ""}${num(b.bias, 1)}` : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {b.n ? `n = ${b.n} · |diff| ${num(b.meanAbsolute, 1)}` : "no readings"}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {digest.calibration ? (
              <div className="rounded-md border border-border px-3 py-2 text-xs">
                <p className="font-semibold">Least-squares fit onto BIS</p>
                <p className="mt-1 text-muted-foreground">
                  BIS ≈ {digest.calibration.gain.toFixed(3)} × app index{" "}
                  {digest.calibration.offset >= 0 ? "+" : "−"}{" "}
                  {Math.abs(digest.calibration.offset).toFixed(2)} (n = {digest.calibration.n}).
                  Mean absolute error {digest.calibration.maeBefore.toFixed(1)} →{" "}
                  {digest.calibration.maeAfter.toFixed(1)} index points if applied. Indicative
                  only — BIS is proprietary and this is not a validation.
                </p>
              </div>
            ) : null}

            {digest.divergences.length ? (
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Largest divergences
                </p>
                <ul className="mt-1.5 space-y-1">
                  {digest.divergences.map((d) => (
                    <li
                      key={d.tSeconds}
                      className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs"
                    >
                      <span className="metric-value opacity-80">{formatClock(d.tSeconds)}</span>
                      <span>
                        BIS {d.bis} vs app {d.depthIndex}
                      </span>
                      <span className={cn(Math.abs(d.difference) > 15 && "text-caution")}>
                        {d.difference > 0 ? "+" : ""}
                        {d.difference}
                      </span>
                      {!d.reliable ? (
                        <span className="rounded-full bg-caution/15 px-1.5 text-[10px] text-caution">
                          app unreliable
                        </span>
                      ) : null}
                      {d.sqi != null ? (
                        <span className="text-muted-foreground">SQI {d.sqi} %</span>
                      ) : null}
                      {d.note ? (
                        <span className="truncate text-muted-foreground">{d.note}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {digest.sparse ? (
              <p className="text-xs text-muted-foreground">
                At least 5 paired readings are needed before the AI comparison is worth running.
              </p>
            ) : null}
          </>
        )}

        {error ? <p className="text-xs text-critical">{error}</p> : null}

        {report ? (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-sm font-semibold">{report.headline}</p>
            {[
              { label: "Agreement", text: report.agreement },
              { label: "Bias", text: report.biasReading },
              { label: "Suppression", text: report.suppressionReading },
              { label: "SEF", text: report.sefReading },
              { label: "Divergences", text: report.divergenceReading },
            ]
              .filter((s) => s.text)
              .map((s) => (
                <div key={s.label}>
                  <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {s.label}
                  </p>
                  <p className="text-xs">{s.text}</p>
                </div>
              ))}

            {report.findings.length ? (
              <ul className="space-y-1.5">
                {report.findings.map((f, i) => (
                  <li key={i} className="rounded-md bg-muted/40 px-2.5 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{f.domain}</span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[10px]",
                          CONFIDENCE_TONE[f.confidence] ?? CONFIDENCE_TONE["low"],
                        )}
                      >
                        {f.confidence} confidence
                      </span>
                      {f.tSeconds != null ? (
                        <span className="metric-value text-[10px] opacity-80">
                          {formatClock(f.tSeconds)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1">{f.detail}</p>
                    {f.supporting.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {f.supporting.join(" · ")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {report.modelSuggestions.length ? (
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Suggested model refinements
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                  {report.modelSuggestions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.limitations.length ? (
              <p className="text-[10px] text-muted-foreground">
                Limitations: {report.limitations.join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
