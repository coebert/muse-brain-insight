import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, Gauge, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CalibrationPanel } from "@/components/monitor/CalibrationPanel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getModelPerformance,
  type PerformanceBucket,
} from "@/lib/eeg/model-performance.functions";

export const Route = createFileRoute("/_authenticated/performance")({
  head: () => ({
    meta: [
      { title: "AI model performance — CortexTrace" },
      {
        name: "description",
        content:
          "Precision, recall, confidence calibration and rejection trends for AI EEG alerts, measured against clinician feedback over time.",
      },
      { property: "og:title", content: "AI model performance — CortexTrace" },
      {
        property: "og:description",
        content:
          "Compare AI EEG alert predictions with clinician verdicts: precision, recall, calibration and rejection trends.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ModelPerformancePage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No performance data found.</div>,
});

const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
  { value: "3650", label: "All time" },
];

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="panel p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="metric-value text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function BucketRow({ b }: { b: PerformanceBucket }) {
  const p = (b.precision ?? 0) * 100;
  const r = (b.recall ?? 0) * 100;
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{b.label}</span>
        <span className="metric-value text-[11px] text-muted-foreground">
          {b.truePositives} confirmed · {b.falsePositives} rejected · {b.falseNegatives} missed
        </span>
        <span className="metric-value ml-auto text-xs font-semibold">
          P {pct(b.precision)} · R {pct(b.recall)} · F1 {pct(b.f1)}
        </span>
      </div>
      <div className="space-y-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-marker" style={{ width: `${p}%` }} />
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary" style={{ width: `${r}%` }} />
        </div>
      </div>
    </li>
  );
}

function ModelPerformancePage() {
  const [windowDays, setWindowDays] = useState("90");
  const fetchPerformance = useServerFn(getModelPerformance);

  const { data, isLoading, error } = useQuery({
    queryKey: ["model-performance", windowDays],
    queryFn: () => fetchPerformance({ data: { windowDays: Number(windowDays) } }),
  });

  const trendRows = (data?.rejectionTrend ?? []).map((p) => ({
    period: p.period.slice(5),
    precision: p.precision == null ? null : Math.round(p.precision * 100),
    recall: p.recall == null ? null : Math.round(p.recall * 100),
    rejection: p.rejectionRate == null ? null : Math.round(p.rejectionRate * 100),
    reviewed: p.reviewed,
    missed: p.missed,
  }));

  const calibrationRows = (data?.calibration ?? [])
    .filter((b) => b.count > 0)
    .map((b) => ({
      label: b.label.replace(" confidence", ""),
      Claimed: b.predicted == null ? null : Math.round(b.predicted * 100),
      Observed: b.observed == null ? null : Math.round(b.observed * 100),
      count: b.count,
    }));

  const modelPeriods = Array.from(
    new Set((data?.modelPrecisionTrend ?? []).flatMap((m) => m.points.map((p) => p.period))),
  ).sort();
  const modelRows = modelPeriods.map((period) => {
    const row: Record<string, string | number | null> = { period: period.slice(5) };
    for (const m of data?.modelPrecisionTrend ?? []) {
      const p = m.points.find((x) => x.period === period);
      row[m.model] = p?.precision == null ? null : Math.round(p.precision * 100);
    }
    return row;
  });
  const modelColours = ["hsl(var(--marker))", "hsl(var(--caution))", "hsl(var(--primary))", "hsl(var(--critical))"];

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/">
            <ArrowLeft className="h-3.5 w-3.5" /> Monitor
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Gauge className="h-4 w-4 text-marker" aria-hidden /> AI model performance
          </h1>
          <p className="text-xs text-muted-foreground">
            AI alerts scored against your verdicts: precision, recall (using findings you logged as
            missed), confidence calibration and rejection trends.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/feedback">Feedback analytics</Link>
          </Button>
          <div className="w-40">
            <Select value={windowDays} onValueChange={setWindowDays}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      {isLoading ? (
        <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading performance…
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load model performance."}
        </p>
      ) : null}

      {data ? (
        data.overall.total === 0 ? (
          <p className="panel p-6 text-sm text-muted-foreground">
            No graded alerts in this window. Mark AI alerts correct or incorrect, and log findings the
            reviewer missed, to build precision and recall.
          </p>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile
                label="Precision"
                value={pct(data.overall.precision)}
                hint={`${data.overall.truePositives} confirmed of ${data.overall.truePositives + data.overall.falsePositives} graded`}
              />
              <Tile
                label="Recall"
                value={pct(data.overall.recall)}
                hint={`${data.overall.falseNegatives} finding(s) logged as missed`}
              />
              <Tile label="F1" value={pct(data.overall.f1)} hint="Balance of precision and recall" />
              <Tile
                label="Calibration error"
                value={pct(data.expectedCalibrationError)}
                hint="Mean gap between claimed confidence and observed hit rate"
              />
            </section>

            <section className="panel p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Precision, recall and rejection over time (weekly)
              </h2>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="precision" name="Precision %" stroke="hsl(var(--marker))" dot={false} connectNulls />
                    <Line type="monotone" dataKey="recall" name="Recall %" stroke="hsl(var(--primary))" dot={false} connectNulls />
                    <Line type="monotone" dataKey="rejection" name="Rejection %" stroke="hsl(var(--critical))" dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Confidence calibration
                </h2>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Claimed hit rate for each stated confidence level versus what you actually confirmed.
                </p>
                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={calibrationRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          fontSize: 12,
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Claimed" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Observed" fill="hsl(var(--marker))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  {data.calibration
                    .filter((b) => b.count > 0)
                    .map((b) => (
                      <li key={b.key}>
                        {b.label}: {b.count} graded ·{" "}
                        {b.gap == null
                          ? "no claimed rate"
                          : b.gap >= 0
                            ? `${Math.round(b.gap * 100)} pts under-confident`
                            : `${Math.abs(Math.round(b.gap * 100))} pts over-confident`}
                      </li>
                    ))}
                </ul>
              </section>

              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Precision by model version (weekly)
                </h2>
                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={modelRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="period" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          fontSize: 12,
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {data.modelPrecisionTrend.map((m, i) => (
                        <Line
                          key={m.model}
                          type="monotone"
                          dataKey={m.model}
                          stroke={modelColours[i % modelColours.length]}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Precision / recall by category
                </h2>
                <ul className="mt-3 space-y-3">
                  {data.byCategory.map((b) => (
                    <BucketRow key={b.key} b={b} />
                  ))}
                </ul>
              </section>
              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Precision / recall by severity
                </h2>
                <ul className="mt-3 space-y-3">
                  {data.bySeverity.map((b) => (
                    <BucketRow key={b.key} b={b} />
                  ))}
                </ul>
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Why alerts were rejected
                </h2>
                {data.topRejectionReasons.length ? (
                  <ul className="mt-3 space-y-2 text-sm">
                    {data.topRejectionReasons.map((r) => (
                      <li key={r.reason} className="flex items-baseline gap-2">
                        <span>{r.reason}</span>
                        <span className="metric-value ml-auto text-xs text-muted-foreground">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No rejection reasons recorded.</p>
                )}
              </section>
              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Findings the reviewer missed
                </h2>
                {data.missedFindings.length ? (
                  <ul className="mt-3 space-y-2 text-sm">
                    {data.missedFindings.map((m) => (
                      <li key={`${m.created_at}-${m.title}`}>
                        <span className="font-medium">{m.title}</span>{" "}
                        <span className="text-[11px] text-muted-foreground">
                          {m.category} · {new Date(m.created_at).toLocaleDateString()}
                        </span>
                        {m.reason ? (
                          <p className="text-[11px] text-muted-foreground">{m.reason}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    None logged. Use “Report a finding the reviewer missed” on the AI review panel to
                    start measuring recall.
                  </p>
                )}
              </section>
            </div>
          </>
        )
      ) : null}
    </main>
  );
}
