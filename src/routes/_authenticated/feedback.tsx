import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, Loader2, ThumbsUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getFeedbackAnalytics,
  type FeedbackBucket,
} from "@/lib/eeg/alert-feedback.functions";

export const Route = createFileRoute("/_authenticated/feedback")({
  head: () => ({
    meta: [
      { title: "Alert feedback analytics — CortexTrace" },
      {
        name: "description",
        content:
          "Correct and incorrect rates for AI EEG alerts broken down by alert category, clinician and model version, trended over time.",
      },
      { property: "og:title", content: "Alert feedback analytics — CortexTrace" },
      {
        property: "og:description",
        content:
          "Track how reliable the AI alert reviewer is by category, clinician and model version over time.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FeedbackAnalyticsPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No feedback found.</div>,
});

const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
  { value: "3650", label: "All time" },
];

const SERIES_COLOURS = [
  "hsl(var(--marker))",
  "hsl(var(--caution))",
  "hsl(var(--critical))",
  "hsl(var(--primary))",
];

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function AccuracyBar({ b }: { b: FeedbackBucket }) {
  const graded = b.correct + b.incorrect;
  const correctPct = graded ? (b.correct / graded) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{b.label}</span>
        <span className="metric-value text-xs text-muted-foreground">
          {b.correct} correct · {b.incorrect} incorrect
          {b.unsure ? ` · ${b.unsure} unsure` : ""}
        </span>
        <span className="metric-value ml-auto text-sm font-semibold">{pct(b.accuracy)}</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-marker" style={{ width: `${correctPct}%` }} />
        <div className="h-full bg-critical" style={{ width: `${graded ? 100 - correctPct : 0}%` }} />
      </div>
    </div>
  );
}

function BucketPanel({
  title,
  buckets,
  empty,
}: {
  title: string;
  buckets: FeedbackBucket[];
  empty: string;
}) {
  return (
    <section className="panel p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {buckets.length ? (
        <ul className="mt-3 space-y-3">
          {buckets.map((b) => (
            <li key={b.key}>
              <AccuracyBar b={b} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function FeedbackAnalyticsPage() {
  const [windowDays, setWindowDays] = useState("90");
  const fetchAnalytics = useServerFn(getFeedbackAnalytics);

  const { data, isLoading, error } = useQuery({
    queryKey: ["feedback-analytics", windowDays],
    queryFn: () => fetchAnalytics({ data: { windowDays: Number(windowDays) } }),
  });

  const trendRows = (data?.trend ?? []).map((p) => ({
    date: p.date.slice(5),
    accuracy: p.accuracy == null ? null : Math.round(p.accuracy * 100),
    total: p.total,
  }));

  const modelDates = Array.from(
    new Set((data?.modelTrend ?? []).flatMap((m) => m.points.map((p) => p.date))),
  ).sort();
  const modelRows = modelDates.map((d) => {
    const row: Record<string, string | number | null> = { date: d.slice(5) };
    for (const m of data?.modelTrend ?? []) {
      const p = m.points.find((x) => x.date === d);
      row[m.model] = p?.accuracy == null ? null : Math.round(p.accuracy * 100);
    }
    return row;
  });

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
            <ThumbsUp className="h-4 w-4 text-marker" aria-hidden /> Alert feedback analytics
          </h1>
          <p className="text-xs text-muted-foreground">
            How often clinicians agreed with the AI reviewer, by alert category, clinician and
            model version.
          </p>
        </div>
        <div className="ml-auto w-40">
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
      </header>

      {isLoading ? (
        <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading feedback…
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load feedback analytics."}
        </p>
      ) : null}

      {data ? (
        data.totals.total === 0 ? (
          <p className="panel p-6 text-sm text-muted-foreground">
            No alert feedback recorded in this window. Mark AI alerts correct or incorrect on the
            monitor or in the trends review and they will appear here.
          </p>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "Feedback entries", value: String(data.totals.total) },
                { label: "Marked correct", value: String(data.totals.correct) },
                { label: "Marked incorrect", value: String(data.totals.incorrect) },
                { label: "Agreement rate", value: pct(data.totals.accuracy) },
              ].map((t) => (
                <div key={t.label} className="panel p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t.label}
                  </p>
                  <p className="metric-value mt-1 text-2xl font-semibold">{t.value}</p>
                </div>
              ))}
            </section>

            <section className="panel p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Agreement rate over time (%)
              </h2>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={34} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 12,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="accuracy"
                      name="Agreement %"
                      stroke="hsl(var(--marker))"
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="panel p-4">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Agreement by model version over time (%)
              </h2>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={modelRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={34} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {data.modelTrend.map((m, i) => (
                      <Line
                        key={m.model}
                        type="monotone"
                        dataKey={m.model}
                        stroke={SERIES_COLOURS[i % SERIES_COLOURS.length] as string}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              <BucketPanel
                title="By alert category"
                buckets={data.byCategory}
                empty="No categorised feedback yet."
              />
              <BucketPanel
                title="By severity"
                buckets={data.bySeverity}
                empty="No feedback yet."
              />
              <BucketPanel
                title="By clinician"
                buckets={data.byClinician}
                empty="No clinician feedback yet."
              />
              <BucketPanel
                title="By model version"
                buckets={data.byModel}
                empty="No model-tagged feedback yet."
              />
            </div>

            {data.topIncorrectReasons.length ? (
              <section className="panel p-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Most common reasons an alert was marked incorrect
                </h2>
                <ul className="mt-2 space-y-1 text-sm">
                  {data.topIncorrectReasons.map((r) => (
                    <li key={r.reason} className="flex gap-2">
                      <span className="metric-value text-muted-foreground">{r.count}×</span>
                      <span>{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )
      ) : null}
    </main>
  );
}
