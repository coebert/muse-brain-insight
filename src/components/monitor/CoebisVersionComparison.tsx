/**
 * Residuals compared across COEBIS model versions, on one fixed pool of paired
 * readings. The fit-quality chip says how the *current* model is doing; this
 * says whether each refit actually helped — overlaid for a quick read, or
 * side-by-side when the shapes need separating.
 */
import { useMemo, useState } from "react";
import { Loader2, Pin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CoebisDriftAlert, CoebisDriftChip } from "@/components/monitor/CoebisDriftAlert";
import type { CoebisVersionResiduals } from "@/lib/eeg/coebis-data.functions";
import { useCoebisModelVersions } from "@/hooks/useCoebisModel";

/** Distinct series colours, in selection order. */
const SERIES = [
  { bar: "bg-signal", text: "text-signal", dot: "bg-signal" },
  { bar: "bg-caution", text: "text-caution", dot: "bg-caution" },
  { bar: "bg-marker", text: "text-marker", dot: "bg-marker" },
  { bar: "bg-critical", text: "text-critical", dot: "bg-critical" },
] as const;

const MAX_SELECTED = SERIES.length;

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

function fittedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "unknown date"
    : d.toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** One version's bar inside a grouped cluster. */
function GroupedBars({
  values,
  max,
  height,
  titles,
}: {
  values: number[];
  max: number;
  height: number;
  titles: string[];
}) {
  return (
    <span className="flex h-full flex-1 items-end justify-center gap-[2px]">
      {values.map((v, i) => (
        <span
          key={i}
          title={titles[i]}
          className={`w-full max-w-3 rounded-t-sm ${SERIES[i]!.bar}`}
          style={{ height: `${Math.max(2, (v / (max || 1)) * height)}px` }}
        />
      ))}
    </span>
  );
}

export function CoebisVersionComparison({
  versions,
  loading,
  error,
}: {
  versions: CoebisVersionResiduals[];
  loading: boolean;
  error: string | null;
}) {
  const [layout, setLayout] = useState<"overlay" | "side">("overlay");
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const { active, select } = useCoebisModelVersions();

  // Default to the active fit plus the one before it — the comparison a
  // clinician actually wants after a refit.
  const defaults = useMemo(() => versions.slice(0, 2).map((v) => v.id), [versions]);
  const chosen = selectedIds ?? defaults;
  const selected = versions.filter((v) => chosen.includes(v.id)).slice(0, MAX_SELECTED);

  function toggle(id: string) {
    const next = chosen.includes(id)
      ? chosen.filter((v) => v !== id)
      : [...chosen, id].slice(-MAX_SELECTED);
    setSelectedIds(next);
  }

  if (loading) {
    return (
      <p className="panel flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Comparing model versions…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="panel p-4 text-sm text-critical">
        {error}
      </p>
    );
  }
  if (versions.length === 0) {
    return (
      <p className="panel p-4 text-sm text-muted-foreground">
        No stored COEBIS fits yet — versions appear here once enough paired commercial BIS readings
        have been entered for a model to be fitted.
      </p>
    );
  }

  const tolerance = versions[0]!.residuals.tolerance;
  const bins = versions[0]!.residuals.histogram;
  const days = Array.from(
    new Set(selected.flatMap((v) => v.residuals.overTime.map((d) => d.key))),
  )
    .sort()
    .slice(-20);
  const bands = versions[0]!.residuals.byBand.map((b) => b.label);
  const maxBin = Math.max(
    1,
    ...selected.flatMap((v) => v.residuals.histogram.map((b) => b.percent)),
  );

  const best = selected.reduce<CoebisVersionResiduals | null>(
    (acc, v) => (!acc || v.residuals.percentWithin > acc.residuals.percentWithin ? v : acc),
    null,
  );

  // Anything the automatic watch has flagged, pinned or not, is surfaced first.
  const flagged = selected.filter(
    (v) => v.drift.status === "watch" || v.drift.status === "drifting",
  );
  const pinnedVersion = selected.find((v) => active?.id === v.id) ?? null;

  return (
    <div className="space-y-3">
      {flagged.map((v) => (
        <CoebisDriftAlert
          key={v.id}
          drift={v.drift}
          title={`v${v.version}${v.isActive ? " (active)" : pinnedVersion?.id === v.id ? " (pinned)" : ""} — ${
            v.drift.status === "drifting" ? "drift detected" : "agreement slipping"
          }`}
        />
      ))}
      <section className="panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Compare model versions</h2>
          <div className="ml-auto flex gap-1.5">
            {(["overlay", "side"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={layout === k}
                onClick={() => setLayout(k)}
                className={
                  layout === k
                    ? "min-h-9 rounded-full border border-signal bg-signal/15 px-3 text-xs font-medium text-signal"
                    : "min-h-9 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground"
                }
              >
                {k === "overlay" ? "Overlay" : "Side by side"}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Every version is scored on the same pool of paired readings, so the differences are the
          model's and not the evidence's. Pick up to {MAX_SELECTED} versions.
        </p>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {versions.map((v) => {
            const i = selected.findIndex((s) => s.id === v.id);
            const on = i >= 0;
            return (
              <li key={v.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(v.id)}
                  className={
                    on
                      ? "flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 text-xs font-medium"
                      : "flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground"
                  }
                >
                  <span
                    className={`size-2 rounded-full ${on ? SERIES[i]!.dot : "bg-muted-foreground/40"}`}
                    aria-hidden
                  />
                  v{v.version}
                  {v.isActive ? <span className="text-[10px] text-signal">active</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {selected.length === 0 ? (
        <p className="panel p-4 text-sm text-muted-foreground">
          Select at least one version above to compare.
        </p>
      ) : (
        <>
          <section className="panel overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Version</th>
                  <th className="px-3 py-2 text-right">Within ±{tolerance}</th>
                  <th className="px-3 py-2 text-right">Bias</th>
                  <th className="px-3 py-2 text-right">MAE</th>
                  <th className="px-3 py-2 text-right">RMSE</th>
                  <th className="px-3 py-2 text-right">Outliers</th>
                  <th className="px-3 py-2 text-right">Drift</th>
                  <th className="px-3 py-2 text-left">Fitted</th>
                  <th className="px-3 py-2 text-right">Show</th>
                </tr>
              </thead>
              <tbody className="metric-value">
                {selected.map((v, i) => (
                  <tr key={v.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-1.5 text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className={`size-2 rounded-full ${SERIES[i]!.dot}`} aria-hidden />v
                        {v.version}
                        {v.isActive ? <span className="text-signal">· active</span> : null}
                        {active?.id === v.id && !v.isActive ? (
                          <span className="text-muted-foreground">· pinned</span>
                        ) : null}
                      </span>
                    </td>
                    <td className={`px-3 py-1.5 text-right ${SERIES[i]!.text}`}>
                      {v.residuals.percentWithin}%
                      {best?.id === v.id && selected.length > 1 ? " ★" : ""}
                    </td>
                    <td className="px-3 py-1.5 text-right">{signed(v.residuals.bias)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {v.residuals.mae?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {v.residuals.rmse?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right">{v.residuals.outliers}</td>
                    <td className="px-3 py-1.5 text-right">
                      <CoebisDriftChip drift={v.drift} />
                    </td>
                    <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                      {fittedLabel(v.createdAt)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-xs"
                        onClick={() => select(v.isActive ? null : v.id)}
                      >
                        <Pin className="mr-1 size-3.5" aria-hidden />
                        {v.isActive ? "Live" : "Pin"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              ★ marks the best agreement of the selected versions. Pinning changes the COEBIS number
              shown across the app; it does not refit anything. The drift column compares each
              version's earlier readings against its most recent ones and flags it when the residual
              histogram shifts or the share within ±{tolerance} falls away.
            </p>
          </section>

          <section className="panel p-3">
            <h3 className="mb-2 text-sm font-semibold">Residual distribution</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Share of readings at each distance from the monitor. A newer model should be taller in
              the middle and thinner at the edges.
            </p>
            {layout === "overlay" ? (
              <div className="flex items-end gap-1 overflow-x-auto pb-1" style={{ height: 150 }}>
                {bins.map((b, bi) => (
                  <div key={b.label} className="flex w-12 shrink-0 flex-col items-center gap-1">
                    <GroupedBars
                      height={110}
                      max={maxBin}
                      values={selected.map((v) => v.residuals.histogram[bi]?.percent ?? 0)}
                      titles={selected.map(
                        (v) =>
                          `v${v.version} · ${b.label} · ${v.residuals.histogram[bi]?.percent ?? 0}% (n ${v.residuals.histogram[bi]?.n ?? 0})`,
                      )}
                    />
                    <span className="text-[10px] whitespace-nowrap text-muted-foreground">
                      {b.label}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {selected.map((v, i) => (
                  <div key={v.id} className="rounded-md border border-border p-2">
                    <p className={`mb-2 text-xs font-medium ${SERIES[i]!.text}`}>
                      v{v.version} · {v.residuals.percentWithin}% within ±{tolerance}
                    </p>
                    <ul className="space-y-1">
                      {v.residuals.histogram.map((b) => {
                        const inside = b.from >= -tolerance && b.to <= tolerance;
                        return (
                          <li key={b.label} className="flex items-center gap-2">
                            <span className="metric-value w-20 shrink-0 text-[10px] text-muted-foreground">
                              {b.label}
                            </span>
                            <span className="h-2.5 flex-1 overflow-hidden rounded-sm bg-muted">
                              <span
                                className={`block h-full ${inside ? SERIES[i]!.bar : "bg-muted-foreground/50"}`}
                                style={{ width: `${(b.percent / maxBin) * 100}%` }}
                              />
                            </span>
                            <span className="metric-value w-10 shrink-0 text-right text-[10px] text-muted-foreground">
                              {b.percent}%
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel p-3">
            <h3 className="mb-2 text-sm font-semibold">
              Percent within ±{tolerance} over time
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Each version scored day by day on the same readings. Where an older version sits
              higher, the refit lost ground on that day's cases.
            </p>
            {days.length === 0 ? (
              <p className="text-xs text-muted-foreground">No dated readings yet.</p>
            ) : layout === "overlay" ? (
              <div className="flex items-end gap-1.5 overflow-x-auto pb-1" style={{ height: 150 }}>
                {days.map((key) => (
                  <div key={key} className="flex w-14 shrink-0 flex-col items-center gap-1">
                    <GroupedBars
                      height={110}
                      max={100}
                      values={selected.map(
                        (v) => v.residuals.overTime.find((d) => d.key === key)?.percentWithin ?? 0,
                      )}
                      titles={selected.map((v) => {
                        const d = v.residuals.overTime.find((x) => x.key === key);
                        return `v${v.version} · ${dayLabel(key)} · ${d?.percentWithin ?? 0}% (n ${d?.n ?? 0})`;
                      })}
                    />
                    <span className="text-[10px] whitespace-nowrap text-muted-foreground">
                      {dayLabel(key)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {selected.map((v, i) => (
                  <div key={v.id}>
                    <p className={`mb-1 text-xs font-medium ${SERIES[i]!.text}`}>v{v.version}</p>
                    <div className="flex items-end gap-1 overflow-x-auto pb-1" style={{ height: 80 }}>
                      {days.map((key) => {
                        const d = v.residuals.overTime.find((x) => x.key === key);
                        return (
                          <div key={key} className="flex w-10 shrink-0 flex-col items-center gap-1">
                            <span
                              title={`${dayLabel(key)} · ${d?.percentWithin ?? 0}% (n ${d?.n ?? 0})`}
                              className={`w-full rounded-t-sm ${SERIES[i]!.bar}`}
                              style={{ height: `${Math.max(2, (d?.percentWithin ?? 0) * 0.5)}px` }}
                            />
                            <span className="text-[10px] whitespace-nowrap text-muted-foreground">
                              {dayLabel(key)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel overflow-x-auto p-0">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Depth band</th>
                  {selected.map((v, i) => (
                    <th key={v.id} className={`px-3 py-2 text-right ${SERIES[i]!.text}`}>
                      v{v.version}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="metric-value">
                {bands.map((label) => (
                  <tr key={label} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-1.5 text-xs">{label}</td>
                    {selected.map((v) => {
                      const g = v.residuals.byBand.find((b) => b.label === label);
                      return (
                        <td key={v.id} className="px-3 py-1.5 text-right text-xs">
                          {g && g.n ? `${g.percentWithin}% · n ${g.n}` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Share of readings within ±{tolerance} in each commercial-BIS band, per version — where
              a refit helped and where it did not.
            </p>
          </section>
        </>
      )}
    </div>
  );
}