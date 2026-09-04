import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Database, Loader2 } from "lucide-react";
import { useState } from "react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { CoebisModelPicker } from "@/components/monitor/CoebisModelPicker";
import { CoebisResidualsPanel } from "@/components/monitor/CoebisResidualsPanel";
import { CoebisDriftAlert } from "@/components/monitor/CoebisDriftAlert";
import { CoebisVersionComparison } from "@/components/monitor/CoebisVersionComparison";
import { CoebisRefitHistory } from "@/components/monitor/CoebisRefitHistory";
import { CoebisValidationPanel } from "@/components/monitor/CoebisValidationPanel";
import { BisModelPanel } from "@/components/monitor/BisModelPanel";
import { ProspectiveValidationPanel } from "@/components/monitor/ProspectiveValidationPanel";
import { DataExchangePanel } from "@/components/monitor/DataExchangePanel";
import { formatClock } from "@/lib/eeg/format";
import {
  getCoebisTrainingData,
  getCoebisVersionResiduals,
} from "@/lib/eeg/coebis-data.functions";

export const Route = createFileRoute("/_authenticated/coebis")({
  head: () => ({
    meta: [
      { title: "COEBIS training data — CortexTrace" },
      {
        name: "description",
        content:
          "Every paired commercial BIS and open depth-index reading the COEBIS model is currently learning from, with per-case, per-band and per-knot coverage.",
      },
      { property: "og:title", content: "COEBIS training data — CortexTrace" },
      {
        property: "og:description",
        content:
          "Inspect the paired readings, case coverage and learned corrections behind the COEBIS depth model.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CoebisDataPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No COEBIS data found.</div>,
});

const TABS = [
  { key: "readings", label: "Paired readings" },
  { key: "bis-model", label: "BIS model" },
  { key: "validation", label: "Validation" },
  { key: "prospective", label: "Prospective" },
  { key: "residuals", label: "Residuals" },
  { key: "versions", label: "Version comparison" },
  { key: "cases", label: "By case" },
  { key: "coverage", label: "Coverage & corrections" },
  { key: "exchange", label: "Data exchange" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function CoebisDataPage() {
  const [tab, setTab] = useState<TabKey>("readings");
  /** How the contributing readings are ordered: newest, or biggest error first. */
  const [order, setOrder] = useState<"recent" | "error">("recent");
  /** Hide readings the fit held out, to see only what shaped the model. */
  const [fitOnly, setFitOnly] = useState(false);
  const fetchData = useServerFn(getCoebisTrainingData);
  const fetchVersions = useServerFn(getCoebisVersionResiduals);

  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-training-data"],
    queryFn: () => fetchData(),
  });

  const versionQuery = useQuery({
    queryKey: ["coebis-version-residuals"],
    queryFn: () => fetchVersions(),
    enabled: tab === "versions",
  });

  /** Contributing readings, ordered and filtered for inspection. */
  const shownPoints = (data?.points ?? [])
    .filter((p) => (fitOnly ? p.usedInFit : true))
    .slice()
    .sort((a, b) =>
      order === "error"
        ? (b.errorShare ?? 0) - (a.errorShare ?? 0)
        : b.recordedAt.localeCompare(a.recordedAt),
    );

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/performance">
            <ArrowLeft className="size-4" /> Performance
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Database className="size-5 text-signal" /> COEBIS training data
        </h1>
        <div className="ml-auto">
          <CoebisModelPicker />
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Everything the COEBIS model is currently learning from: each paired commercial BIS value and
        the open index recorded beside it, which readings are inside the fit, and the corrections
        that have been learned across the depth range. Nothing here is a BIS reimplementation — it
        is agreement data for the app's own index.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading paired readings…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load the training data."}
        </p>
      ) : !data ? null : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Paired readings"
              value={String(data.totalPoints)}
              hint={`${data.thresholds.points} needed before any correction is fitted`}
            />
            <Tile
              label="In the fit"
              value={String(data.usedPoints)}
              hint={
                data.fitBasis === "reliable"
                  ? `${data.excludedPoints} held out as unreliable at the time`
                  : "Too few reliable readings — the fit is using every reading"
              }
            />
            <Tile
              label="Cases contributing"
              value={String(data.sessions)}
              hint={`${data.thresholds.sessions} cases needed to activate a model`}
            />
            <Tile
              label="Active model"
              value={data.active ? data.active.modelVersion : "None"}
              hint={
                data.active
                  ? `Fitted ${when(data.active.createdAt)} · MAE ${data.active.maeBefore?.toFixed(1) ?? "—"} → ${data.active.maeAfter?.toFixed(1) ?? "—"}`
                  : "COEBIS is still watching; the published open index is shown unchanged"
              }
            />
          </div>

          {data.active ? (
            <p className="panel metric-value p-3 text-xs text-muted-foreground">
              COEBIS ≈ {data.active.gain.toFixed(3)} × index{" "}
              {data.active.offset >= 0 ? "+" : "−"} {Math.abs(data.active.offset).toFixed(1)}, plus
              the learned per-band corrections below. Fitted on {data.active.nPoints} readings from{" "}
              {data.active.nSessions} cases · bias {data.active.biasBefore?.toFixed(1) ?? "—"} →{" "}
              {data.active.biasAfter?.toFixed(1) ?? "—"} index points.
            </p>
          ) : null}

          {data.candidate ? (
            <div className="panel p-3 text-xs">
              <p className="mb-1 font-medium">
                Newest fit from the last refit run · {data.candidate.lineageKey}{" "}
                {data.candidate.modelVersion}
                <span
                  className={
                    data.candidate.promoted
                      ? "ml-2 rounded bg-signal/15 px-1.5 py-0.5 text-signal"
                      : "ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                  }
                >
                  {data.candidate.isActive
                    ? "in force"
                    : data.candidate.promoted
                      ? "promoted"
                      : "not promoted"}
                </span>
              </p>
              <p className="text-muted-foreground">
                Held-out error {data.candidate.maeBefore?.toFixed(2) ?? "—"} →{" "}
                {data.candidate.maeAfter?.toFixed(2) ?? "—"} index points on{" "}
                {data.candidate.nPoints ?? "—"} readings from {data.candidate.nCases ?? "—"} cases,
                fitted {when(data.candidate.createdAt)}.{" "}
                {data.candidate.reason ?? ""}
              </p>
            </div>
          ) : null}

          <div role="tablist" aria-label="COEBIS data views" className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={
                  tab === t.key
                    ? "min-h-11 rounded-full border border-signal bg-signal/15 px-4 text-sm font-medium text-signal sm:min-h-9"
                    : "min-h-11 rounded-full border border-border px-4 text-sm font-medium text-muted-foreground sm:min-h-9"
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "bis-model" ? <BisModelPanel /> : null}

          {tab === "validation" ? <CoebisValidationPanel /> : null}

          {tab === "prospective" ? <ProspectiveValidationPanel /> : null}

          {tab === "exchange" ? <DataExchangePanel /> : null}

          {tab === "readings" ? (
            <section className="panel overflow-x-auto p-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  Every reading behind the current fit, with the share of the model's total error it
                  contributes.
                </p>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOrder(order === "recent" ? "error" : "recent")}
                    className="min-h-9 rounded-full border border-border px-3 text-xs font-medium"
                  >
                    {order === "recent" ? "Newest first" : "Largest error first"}
                  </button>
                  <button
                    type="button"
                    aria-pressed={fitOnly}
                    onClick={() => setFitOnly(!fitOnly)}
                    className={
                      fitOnly
                        ? "min-h-9 rounded-full border border-signal bg-signal/15 px-3 text-xs font-medium text-signal"
                        : "min-h-9 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground"
                    }
                  >
                    In-fit only
                  </button>
                </div>
              </div>
              {shownPoints.length ? (
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Recorded</th>
                      <th className="px-3 py-2 text-left">Case</th>
                      <th className="px-3 py-2 text-right">Case clock</th>
                      <th className="px-3 py-2 text-right">BIS</th>
                      <th className="px-3 py-2 text-right">Open index</th>
                      <th className="px-3 py-2 text-right">COEBIS</th>
                      <th className="px-3 py-2 text-right">Diff</th>
                      <th className="px-3 py-2 text-right">Residual</th>
                      <th className="px-3 py-2 text-right">Error share</th>
                      <th className="px-3 py-2 text-right">SQI</th>
                      <th className="px-3 py-2 text-left">In fit</th>
                    </tr>
                  </thead>
                  <tbody className="metric-value">
                    {shownPoints.map((p, i) => (
                      <tr
                        key={`${p.recordedAt}-${i}`}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                          {when(p.recordedAt)}
                        </td>
                        <td className="px-3 py-1.5 text-xs">{p.caseCode}</td>
                        <td className="px-3 py-1.5 text-right text-xs">{formatClock(p.at)}</td>
                        <td className="px-3 py-1.5 text-right">{p.bis.toFixed(0)}</td>
                        <td className="px-3 py-1.5 text-right">{p.raw.toFixed(0)}</td>
                        <td className="px-3 py-1.5 text-right">
                          {p.corrected == null ? "—" : p.corrected.toFixed(0)}
                        </td>
                        <td
                          className={
                            Math.abs(p.diff) >= 10
                              ? "px-3 py-1.5 text-right text-critical"
                              : "px-3 py-1.5 text-right"
                          }
                        >
                          {p.diff > 0 ? "+" : ""}
                          {p.diff.toFixed(1)}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {p.residual == null
                            ? "—"
                            : `${p.residual > 0 ? "+" : ""}${p.residual.toFixed(1)}`}
                        </td>
                        <td
                          className={
                            p.withinTolerance === false
                              ? "px-3 py-1.5 text-right text-caution"
                              : "px-3 py-1.5 text-right"
                          }
                        >
                          {p.errorShare == null ? "—" : `${p.errorShare.toFixed(2)}%`}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {p.sqi == null ? "—" : p.sqi.toFixed(0)}
                        </td>
                        <td className="px-3 py-1.5 text-xs">
                          {p.usedInFit ? (
                            <span className="text-signal">Yes</span>
                          ) : (
                            <span className="text-muted-foreground">Held out</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  No paired readings yet. Enter values from the commercial BIS monitor during a case
                  and they appear here when the case is filed.
                </p>
              )}
              {data.totalPoints > data.points.length ? (
                <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  Showing {shownPoints.length} of {data.totalPoints} readings (most recent 300 are
                  listed). Error shares are measured against every reading the model fits on.
                </p>
              ) : null}
            </section>
          ) : null}

          {tab === "residuals" ? (
            <div className="space-y-3">
              {data.drift ? (
                <CoebisDriftAlert drift={data.drift} title="Active model drift watch" />
              ) : null}
              <CoebisResidualsPanel residuals={data.residuals} />
            </div>
          ) : null}

          {tab === "versions" ? (
            <div className="space-y-3">
              <CoebisVersionComparison
                versions={versionQuery.data ?? []}
                loading={versionQuery.isLoading}
                error={
                  versionQuery.error
                    ? versionQuery.error instanceof Error
                      ? versionQuery.error.message
                      : "Could not compare model versions."
                    : null
                }
              />
              <CoebisRefitHistory />
            </div>
          ) : null}

          {tab === "cases" ? (
            <section className="panel overflow-x-auto p-0">
              {data.cases.length ? (
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Case</th>
                      <th className="px-3 py-2 text-right">Readings</th>
                      <th className="px-3 py-2 text-right">Reliable</th>
                      <th className="px-3 py-2 text-right">Mean offset</th>
                      <th className="px-3 py-2 text-right">MAE</th>
                      <th className="px-3 py-2 text-right">Within ±5</th>
                      <th className="px-3 py-2 text-right">Error share</th>
                      <th className="px-3 py-2 text-right">Worst</th>
                      <th className="px-3 py-2 text-left">First</th>
                      <th className="px-3 py-2 text-left">Last</th>
                    </tr>
                  </thead>
                  <tbody className="metric-value">
                    {data.cases.map((c) => (
                      <tr
                        key={c.sessionId ?? "unfiled"}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="px-3 py-1.5 text-xs">{c.caseCode}</td>
                        <td className="px-3 py-1.5 text-right">{c.points}</td>
                        <td className="px-3 py-1.5 text-right">{c.reliablePoints}</td>
                        <td className="px-3 py-1.5 text-right">
                          {c.meanBias == null
                            ? "—"
                            : `${c.meanBias > 0 ? "+" : ""}${c.meanBias.toFixed(1)}`}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {c.mae == null ? "—" : c.mae.toFixed(1)}
                        </td>
                        <td
                          className={
                            c.percentWithin != null && c.percentWithin < 60
                              ? "px-3 py-1.5 text-right text-critical"
                              : "px-3 py-1.5 text-right"
                          }
                        >
                          {c.percentWithin == null ? "—" : `${c.percentWithin}%`}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {c.errorShare == null ? "—" : `${c.errorShare.toFixed(1)}%`}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {c.worstResidual == null
                            ? "—"
                            : `${c.worstResidual > 0 ? "+" : ""}${c.worstResidual.toFixed(1)}`}
                        </td>
                        <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                          {when(c.firstRecordedAt)}
                        </td>
                        <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                          {when(c.lastRecordedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  No cases have contributed paired readings yet.
                </p>
              )}
            </section>
          ) : null}

          {tab === "coverage" ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <section className="panel p-3">
                <h2 className="mb-2 text-sm font-semibold">Depth-band coverage</h2>
                <p className="mb-2 text-xs text-muted-foreground">
                  How many paired readings sit in each BIS band, and how far the open index sits
                  from the monitor there. Sparse bands are the ones COEBIS can say least about.
                </p>
                <ul className="space-y-1.5">
                  {data.bands.map((b) => (
                    <li key={b.band} className="flex items-baseline gap-2 text-sm">
                      <span className="w-28 shrink-0 text-xs">{b.band}</span>
                      <span className="metric-value text-xs text-muted-foreground">
                        n {b.n} · offset{" "}
                        {b.bias == null ? "—" : `${b.bias > 0 ? "+" : ""}${b.bias.toFixed(1)}`} ·
                        MAE {b.meanAbsolute == null ? "—" : b.meanAbsolute.toFixed(1)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="panel p-3">
                <h2 className="mb-2 text-sm font-semibold">Learned corrections</h2>
                <p className="mb-2 text-xs text-muted-foreground">
                  COEBIS learns a small residual correction at each point on the aligned scale, with
                  the evidence behind it. A correction of zero means too few readings nearby, so
                  that part of the range stays on the straight-line alignment.
                </p>
                <ul className="space-y-1.5">
                  {data.knots.map((k) => (
                    <li key={k.x} className="flex items-baseline gap-2 text-sm">
                      <span className="metric-value w-12 shrink-0 text-xs">{k.x}</span>
                      <span className="metric-value text-xs text-muted-foreground">
                        n {k.n} · correction{" "}
                        {k.dy == null ? "—" : `${k.dy > 0 ? "+" : ""}${k.dy.toFixed(2)}`} points
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}