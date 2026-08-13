/**
 * Where the active COEBIS fit is failing: residual size distribution, observed
 * percent within tolerance over time, and the depth bands and cases with the
 * weakest agreement.
 */
import type { CoebisResiduals } from "@/lib/eeg/coebis-residuals";

function toneFor(percent: number): string {
  if (percent >= 80) return "text-signal";
  if (percent >= 60) return "text-caution";
  return "text-critical";
}

function barTone(percent: number): string {
  if (percent >= 80) return "bg-signal";
  if (percent >= 60) return "bg-caution";
  return "bg-critical";
}

function signed(v: number | null, dp = 1): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
}

function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? key
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="panel p-3">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="metric-value text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function GroupRows({
  rows,
  empty,
}: {
  rows: { label: string; n: number; percentWithin: number; bias: number | null; mae: number | null }[];
  empty: string;
}) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((g) => (
        <li key={g.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate text-xs">{g.label}</span>
            <span className={`metric-value text-xs ${g.n ? toneFor(g.percentWithin) : "text-muted-foreground"}`}>
              {g.n ? `${g.percentWithin}%` : "—"}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${barTone(g.percentWithin)}`}
              style={{ width: `${g.n ? g.percentWithin : 0}%` }}
            />
          </div>
          <p className="metric-value text-[11px] text-muted-foreground">
            n {g.n} · bias {signed(g.bias)} · MAE {g.mae == null ? "—" : g.mae.toFixed(1)}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function CoebisResidualsPanel({ residuals }: { residuals: CoebisResiduals | null }) {
  if (!residuals || residuals.n === 0) {
    return (
      <p className="panel p-4 text-sm text-muted-foreground">
        No residuals yet — a COEBIS model has to be fitted, and paired commercial BIS readings
        recorded, before agreement can be broken down.
      </p>
    );
  }

  const maxBin = Math.max(...residuals.histogram.map((b) => b.n), 1);
  const recent = residuals.overTime.slice(-30);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={`Within ±${residuals.tolerance}`}
          value={`${residuals.percentWithin}%`}
          hint={`${residuals.withinTolerance} of ${residuals.n} paired readings (observed, not estimated)`}
        />
        <Tile
          label="Residual bias"
          value={signed(residuals.bias)}
          hint="Mean COEBIS − commercial BIS; positive = COEBIS reads lighter"
        />
        <Tile
          label="MAE / RMSE"
          value={`${residuals.mae?.toFixed(1) ?? "—"} / ${residuals.rmse?.toFixed(1) ?? "—"}`}
          hint="RMSE well above MAE means a heavy tail of large misses"
        />
        <Tile
          label="Outliers"
          value={String(residuals.outliers)}
          hint={`Beyond ±${residuals.tolerance * 2} points · worst ${residuals.worstAbs?.toFixed(1) ?? "—"}`}
        />
      </div>

      <section className="panel p-3">
        <h2 className="mb-2 text-sm font-semibold">Residual distribution</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          How far each paired reading sits from the monitor after the active correction. A tall,
          centred peak is a healthy fit; a shifted peak means residual bias, and fat edges mean the
          model misses badly in part of the range.
        </p>
        <ul className="space-y-1">
          {residuals.histogram.map((b) => {
            const inside = b.from >= -residuals.tolerance && b.to <= residuals.tolerance;
            return (
              <li key={b.label} className="flex items-center gap-2">
                <span className="metric-value w-24 shrink-0 text-[11px] text-muted-foreground">
                  {b.label}
                </span>
                <span className="h-3 flex-1 overflow-hidden rounded-sm bg-muted">
                  <span
                    className={`block h-full ${inside ? "bg-signal" : "bg-caution"}`}
                    style={{ width: `${(b.n / maxBin) * 100}%` }}
                  />
                </span>
                <span className="metric-value w-20 shrink-0 text-right text-[11px] text-muted-foreground">
                  {b.n} · {b.percent}%
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel p-3">
        <h2 className="mb-2 text-sm font-semibold">
          Percent within ±{residuals.tolerance} over time
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Agreement per day of paired readings, oldest first. A downward trend means the model is
          drifting away from the monitor and is due a refit.
        </p>
        <div className="flex items-end gap-1 overflow-x-auto pb-1" style={{ height: 120 }}>
          {recent.map((d) => (
            <div key={d.key} className="flex w-8 shrink-0 flex-col items-center gap-1">
              <span className="metric-value text-[11px] text-muted-foreground">
                {d.percentWithin}
              </span>
              <span
                title={`${dayLabel(d.key)} · n ${d.n} · bias ${signed(d.bias)} · MAE ${d.mae?.toFixed(1) ?? "—"}`}
                className={`w-full rounded-t-sm ${barTone(d.percentWithin)}`}
                style={{ height: `${Math.max(2, d.percentWithin * 0.7)}px` }}
              />
              <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                {dayLabel(d.key)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="panel p-3">
          <h2 className="mb-2 text-sm font-semibold">By depth band</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Where in the depth range the fit holds. A weak band is where COEBIS should be read with
            most caution.
          </p>
          <GroupRows rows={residuals.byBand} empty="No banded readings yet." />
        </section>

        <section className="panel p-3">
          <h2 className="mb-2 text-sm font-semibold">Weakest cases</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Cases with the lowest share of readings inside tolerance (three readings or more) — often
            a montage or signal-quality problem rather than a model one.
          </p>
          <GroupRows rows={residuals.byCase} empty="No case has three or more paired readings yet." />
        </section>
      </div>
    </div>
  );
}
