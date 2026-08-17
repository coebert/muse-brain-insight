import { Target } from "lucide-react";

import type { DiscriminationReport } from "@/lib/eeg/discrimination-report";

function num(v: number | null | undefined, digits = 3): string {
  return v == null ? "—" : v.toFixed(digits);
}

function pkTone(pk: number | null): string {
  if (pk == null) return "text-muted-foreground";
  if (pk >= 0.85) return "text-signal";
  if (pk >= 0.75) return "";
  return "text-warning";
}

/**
 * The standard depth-monitor validation table: prediction probability against
 * ordered clinical states, ROC/AUC at the boundaries that change management,
 * and limits of agreement that separate within-case from between-case scatter.
 */
export function DiscriminationPanel({
  report,
  title = "Discrimination of clinical states",
}: {
  report: DiscriminationReport;
  title?: string;
}) {
  if (!report.indices.length) {
    return (
      <section className="panel p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Target className="size-4 text-signal" /> {title}
        </h3>
        <p className="text-sm text-muted-foreground">{report.summary}</p>
      </section>
    );
  }

  const boundaries = report.indices[0]!.boundaries;

  return (
    <section className="panel space-y-3 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Target className="size-4 text-signal" /> {title}
      </h3>
      <p className="text-sm">{report.summary}</p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] text-sm">
          <thead className="text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="py-1 text-left">Index</th>
              <th className="py-1 text-right">Readings</th>
              <th className="py-1 text-right">Pk</th>
              {boundaries.map((b) => (
                <th key={b.key} className="py-1 text-right" title={b.description}>
                  AUC — {b.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="metric-value">
            {report.indices.map((idx) => (
              <tr key={idx.key} className="border-t border-border">
                <td className="py-1.5 text-left font-medium">
                  {idx.label}
                  {idx.reference ? (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      defines the states
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 text-right">{idx.n}</td>
                <td className={`py-1.5 text-right ${idx.reference ? "text-muted-foreground" : pkTone(idx.pk.pk)}`}>
                  {num(idx.pk.pk)}
                  {idx.pk.se != null ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ± {(1.96 * idx.pk.se).toFixed(3)}
                    </span>
                  ) : null}
                </td>
                {boundaries.map((b) => {
                  const match = idx.boundaries.find((x) => x.key === b.key);
                  return (
                    <td key={b.key} className="py-1.5 text-right">
                      {num(match?.roc.auc ?? null, 2)}
                      {match?.roc.bestThreshold != null && !idx.reference ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          @ {match.roc.bestThreshold.toFixed(0)}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <h4 className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">
          Limits of agreement, repeated readings accounted for
        </h4>
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="py-1 text-left">Index</th>
              <th className="py-1 text-right">Bias</th>
              <th className="py-1 text-right">Limits</th>
              <th className="py-1 text-right">Naive limits</th>
              <th className="py-1 text-right">Case share (ICC)</th>
            </tr>
          </thead>
          <tbody className="metric-value">
            {report.indices
              .filter((i) => i.blandAltman)
              .map((i) => {
                const ba = i.blandAltman!;
                return (
                  <tr key={i.key} className="border-t border-border">
                    <td className="py-1.5 text-left font-medium">{i.label}</td>
                    <td className="py-1.5 text-right">{num(ba.bias, 1)}</td>
                    <td className="py-1.5 text-right">
                      {ba.limits ? `${ba.limits[0].toFixed(1)} to ${ba.limits[1].toFixed(1)}` : "—"}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground">
                      {ba.naiveLimits
                        ? `${ba.naiveLimits[0].toFixed(1)} to ${ba.naiveLimits[1].toFixed(1)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 text-right">
                      {ba.icc == null ? "—" : `${Math.round(ba.icc * 100)} %`}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        States seen: {report.states.filter((s) => s.n).map((s) => `${s.label} (${s.n})`).join(", ") || "—"}.
        Pk 1.0 means every pair of different clinical states was ordered correctly, 0.5 is a coin
        toss. Thresholds shown beside each AUC are the value that best separated that boundary.
      </p>
    </section>
  );
}
