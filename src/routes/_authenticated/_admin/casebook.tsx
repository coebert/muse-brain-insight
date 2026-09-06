import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, LayoutDashboard, Loader2 } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { buildCaseDashboard, MIN_TREND_CASES, type CaseRow } from "@/lib/eeg/case-dashboard";
import { getOutcomeReport } from "@/lib/eeg/outcomes.functions";

export const Route = createFileRoute("/_authenticated/_admin/casebook")({
  head: () => ({
    meta: [
      { title: "Case dashboard — CortexTrace" },
      {
        name: "description",
        content:
          "Every bedside case with its depth index, suppression exposure and recorded recovery side by side, plus month-by-month trends.",
      },
      { property: "og:title", content: "Case dashboard — CortexTrace" },
      {
        property: "og:description",
        content: "Depth, suppression and recovery for every bedside case, with trends over time.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CasebookPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No cases found.</div>,
});

const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "—";

function FlagPill({ row }: { row: CaseRow }) {
  if (row.flag === "unrecorded") {
    return <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Not recorded</span>;
  }
  if (row.flag === "clear") {
    return <span className="rounded-full bg-signal/15 px-2 py-0.5 text-xs text-signal">Uneventful</span>;
  }
  return (
    <span className="rounded-full bg-critical/15 px-2 py-0.5 text-xs text-critical">
      {row.adverse.join(", ")}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function CasebookPage() {
  const fetchReport = useServerFn(getOutcomeReport);
  const { data, isLoading, error } = useQuery({
    queryKey: ["outcome-report"],
    queryFn: () => fetchReport(),
  });

  const dashboard = useMemo(() => buildCaseDashboard(data?.cases ?? []), [data]);
  const { rows, trend, totals } = dashboard;
  const thin = trend.length > 0 && trend.every((t) => !t.readable);

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/cases">
            <ArrowLeft className="size-4" /> Cases
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <LayoutDashboard className="size-5 text-signal" /> Case dashboard
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Depth, suppression and what happened afterwards, for every case recorded at the bedside.
        These are descriptions of what was measured, not predictions — a difference between a
        handful of cases is not yet a finding.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading the cases…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {(error as Error).message}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cases have been recorded yet. Start one on the bedside screen and it will appear here.
        </p>
      ) : (
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Cases recorded" value={String(totals.cases)} hint={`${totals.outcomesRecorded} with a recovery recorded`} />
            <Stat
              label="Average depth index"
              value={totals.meanDepth == null ? "—" : totals.meanDepth.toFixed(1)}
              hint="Across the whole case"
            />
            <Stat
              label="Time suppressed"
              value={`${totals.meanSuppressedPercent.toFixed(1)}%`}
              hint={`${totals.minutesSuppressed.toFixed(0)} minutes in total`}
            />
            <Stat
              label="Cases with a problem"
              value={String(totals.adverse)}
              hint="Delirium, difficult waking, awareness, intensive care or death"
            />
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Month by month</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Average depth index and suppression per month, with the number of cases that had a
              problem afterwards. Months with fewer than {MIN_TREND_CASES} cases are too thin to
              read as a trend.
            </p>
            {thin ? (
              <p className="mt-2 text-xs text-caution">
                Every month so far holds fewer than {MIN_TREND_CASES} cases — treat the shape of
                this chart as a tally, not a trend.
              </p>
            ) : null}
            <div className="mt-3 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, currentColor)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" />
                  <YAxis yAxisId="left" domain={[0, 100]} tick={{ fontSize: 11 }} stroke="currentColor" />
                  <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border, currentColor)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="right" dataKey="adverse" name="Cases with a problem" fill="var(--color-critical, currentColor)" barSize={18} />
                  <Line yAxisId="left" type="monotone" dataKey="meanDepth" name="Depth index" stroke="var(--color-signal, currentColor)" strokeWidth={2} dot />
                  <Line yAxisId="left" type="monotone" dataKey="meanSuppressedPercent" name="Time suppressed (%)" stroke="var(--color-caution, currentColor)" strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card">
            <h2 className="border-b border-border p-4 text-sm font-semibold">Case by case</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="p-3 font-medium">Case</th>
                    <th className="p-3 font-medium">Date</th>
                    <th className="p-3 font-medium text-right">Length</th>
                    <th className="p-3 font-medium text-right">Depth index</th>
                    <th className="p-3 font-medium text-right">Below 40</th>
                    <th className="p-3 font-medium text-right">Suppressed</th>
                    <th className="p-3 font-medium">Recovery</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.sessionId} className="border-b border-border/60 last:border-0">
                      <td className="p-3 font-medium">
                        <Link
                          to="/case/$caseRef"
                          params={{ caseRef: row.caseCode || row.sessionId }}
                          className="text-signal hover:underline"
                        >
                          {row.caseCode || "Unnamed case"}
                        </Link>
                        {row.ageBand ? (
                          <span className="ml-2 text-xs text-muted-foreground">{row.ageBand}</span>
                        ) : null}
                      </td>
                      <td className="p-3 text-muted-foreground">{dateLabel(row.startedAt)}</td>
                      <td className="p-3 text-right tabular-nums">{row.durationMinutes.toFixed(0)} min</td>
                      <td className="p-3 text-right tabular-nums">
                        {row.meanDepth == null ? "—" : row.meanDepth.toFixed(1)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {row.minutesDeep.toFixed(0)} min
                        <span className="ml-1 text-xs text-muted-foreground">({row.deepPercent.toFixed(0)}%)</span>
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {row.minutesSuppressed.toFixed(0)} min
                        <span className="ml-1 text-xs text-muted-foreground">({row.suppressedPercent.toFixed(0)}%)</span>
                      </td>
                      <td className="p-3">
                        <FlagPill row={row} />
                        {row.outcome?.lengthOfStayDays != null ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {row.outcome.lengthOfStayDays} days in hospital
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border p-3 text-xs text-muted-foreground">
              Recoveries are recorded on the{" "}
              <Link to="/outcomes" className="text-signal hover:underline">
                case outcomes page
              </Link>
              .
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
