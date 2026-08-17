import { Gauge } from "lucide-react";

import {
  CURRENT_DEGRADED_BELOW,
  CURRENT_UNRELIABLE_BELOW,
  type ConfidenceCalibration,
} from "@/lib/eeg/depth-confidence-calibration";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)} %`);

/**
 * Are the reliability cut-offs honest? The app calls a depth reading unreliable
 * below a confidence of 0.35 and reliable above 0.6. This shows how often
 * readings at each stated confidence actually landed within 10 points of the
 * monitor, and where the data would put those lines.
 */
export function ConfidenceCalibrationPanel({ report }: { report: ConfidenceCalibration }) {
  return (
    <section className="panel space-y-3 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Gauge className="size-4 text-signal" /> Are the reliability cut-offs honest?
      </h3>
      <p className="text-sm">{report.summary}</p>

      {report.n ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[26rem] text-sm">
            <thead className="text-xs tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="py-1 text-left">Stated confidence</th>
                <th className="py-1 text-right">Readings</th>
                <th className="py-1 text-right">Within {report.tolerance} points</th>
              </tr>
            </thead>
            <tbody className="metric-value">
              {report.bins.map((b) => (
                <tr key={b.label} className="border-t border-border">
                  <td className="py-1.5 text-left">{b.label}</td>
                  <td className="py-1.5 text-right">{b.n}</td>
                  <td className="py-1.5 text-right">{pct(b.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Unreliable line</dt>
          <dd className="metric-value">
            {CURRENT_UNRELIABLE_BELOW.toFixed(2)}
            {report.recommended.unreliableBelow != null ? (
              <span className="ml-2 text-xs text-muted-foreground">
                data suggests {report.recommended.unreliableBelow.toFixed(2)}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Reliable line</dt>
          <dd className="metric-value">
            {CURRENT_DEGRADED_BELOW.toFixed(2)}
            {report.recommended.degradedBelow != null ? (
              <span className="ml-2 text-xs text-muted-foreground">
                data suggests {report.recommended.degradedBelow.toFixed(2)}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <p className="text-xs text-muted-foreground">
        Cut-offs are not moved automatically: they change what the monitor tells you at the bedside,
        so a shift is a deliberate decision once enough readings support it.
      </p>
    </section>
  );
}
