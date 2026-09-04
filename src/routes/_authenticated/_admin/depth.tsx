import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, ArrowRight, Loader2 } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSuppressionDashboard } from "@/lib/eeg/suppression-dashboard.functions";
import {
  APP_FLAG_PCT,
  type BisAgreement,
  type CaseTrace,
} from "@/lib/eeg/suppression-dashboard";
import { MONITOR_SUPPRESSED_PCT } from "@/lib/eeg/suppression-model";
import { COEBIS_V2_MODEL } from "@/lib/eeg/coebis-v2";

export const Route = createFileRoute("/_authenticated/_admin/depth")({
  head: () => ({
    meta: [
      { title: "Depth dashboard: real BIS beside COEBIS — CortexTrace" },
      {
        name: "description",
        content:
          "Recorded bedside BIS, the suppression ratio and the COEBIS depth model on one clock, case by case, with how far the depth number sits from the monitor on every paired reading.",
      },
      {
        property: "og:title",
        content: "Depth dashboard: real BIS beside COEBIS — CortexTrace",
      },
      {
        property: "og:description",
        content:
          "Per-case traces and per-case agreement: mean BIS, mean COEBIS, average gap, how often it lands within 5 and 10 points, and what suppression was doing at the time.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DepthPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

const num = (v: number | null | undefined, dp = 1, suffix = ""): string =>
  v == null ? "—" : `${v.toFixed(dp)}${suffix}`;

const pct = (part: number, whole: number): string =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "—";

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One case: the monitor's number, the depth model and suppression on one clock. */
function CaseTraceCard({ trace }: { trace: CaseTrace }) {
  const data = trace.samples.map((s) => ({
    ...s,
    monitorMark: s.monitorFlag ? -3 : null,
    appMark: s.appFlag ? -7 : null,
  }));
  const minutes = Math.round(trace.durationSeconds / 60);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span className="truncate font-mono">{trace.caseRef}</span>
          <Badge variant="secondary">{minutes} min</Badge>
          {trace.bis.n ? (
            <Badge variant="outline">
              off by {num(trace.bis.maeCapped)} points
            </Badge>
          ) : (
            <Badge variant="outline">no monitor number recorded</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {trace.bis.n
            ? `BIS ${num(trace.bis.meanBis)} against COEBIS ${num(
                trace.bis.meanCappedIndex,
              )} on ${trace.bis.n.toLocaleString()} shared readings · within 5 points ${pct(
                trace.bis.within5,
                trace.bis.n,
              )}, within 10 ${pct(trace.bis.within10, trace.bis.n)}`
            : "Suppression can be compared on this case, but the depth numbers cannot."}
          {" · monitor SR "}
          {num(trace.meanMonitorSr)}% · model estimate {num(trace.meanEstimatedSr)}%
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="at"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => `${Math.round(v / 60)}m`}
                stroke="currentColor"
                className="text-xs text-muted-foreground"
              />
              <YAxis
                domain={[-10, 100]}
                ticks={[0, 25, 50, 75, 100]}
                stroke="currentColor"
                className="text-xs text-muted-foreground"
                label={{
                  value: "index / SR %",
                  angle: -90,
                  position: "insideLeft",
                  fontSize: 10,
                }}
              />
              <Tooltip
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }}
                labelFormatter={(v: number) => `${Math.round(Number(v) / 60)} min into the case`}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine
                y={MONITOR_SUPPRESSED_PCT}
                strokeDasharray="4 4"
                className="stroke-muted-foreground"
              />
              <Line
                type="monotone"
                dataKey="monitorIndex"
                name="BIS (monitor)"
                stroke="var(--color-success, currentColor)"
                dot={false}
                strokeWidth={1.75}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="cappedIndex"
                name="COEBIS (as read)"
                stroke="var(--color-signal, currentColor)"
                dot={false}
                strokeWidth={1.75}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="index"
                name="COEBIS before the cap"
                stroke="var(--color-signal, currentColor)"
                strokeOpacity={0.45}
                strokeDasharray="4 3"
                dot={false}
                strokeWidth={1.25}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="monitorSr"
                name="Monitor SR %"
                stroke="currentColor"
                strokeOpacity={0.55}
                dot={false}
                strokeWidth={1}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="estimatedSr"
                name="Estimated SR %"
                stroke="var(--color-critical, currentColor)"
                strokeDasharray="3 3"
                dot={false}
                strokeWidth={1}
                isAnimationActive={false}
              />
              <Scatter
                dataKey="monitorMark"
                name={`Monitor flag (SR ≥ ${MONITOR_SUPPRESSED_PCT}%)`}
                fill="currentColor"
                shape="square"
                isAnimationActive={false}
              />
              <Scatter
                dataKey="appMark"
                name={`App flag (est. SR ≥ ${APP_FLAG_PCT}%)`}
                fill="var(--color-critical, currentColor)"
                shape="square"
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <Button asChild variant="outline" size="sm" className="mt-3 min-h-11 sm:min-h-9">
          <Link to="/case/$caseRef" params={{ caseRef: trace.caseRef }}>
            Open case file <ArrowRight className="size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function PooledCard({
  bis,
  patients,
  casesWithBis,
}: {
  bis: BisAgreement;
  patients: number;
  casesWithBis: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">COEBIS against the real monitor</CardTitle>
        <CardDescription>
          {bis.n
            ? `${bis.n.toLocaleString()} readings from ${casesWithBis} of ${patients} patients carry a bedside BIS number at the same second. Everything below is graded on the number clinicians actually read — after the suppression cap.`
            : "No reading carries a bedside BIS number, so the depth numbers cannot be compared."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="Mean BIS" value={num(bis.meanBis)} />
        <Metric
          label="Mean COEBIS"
          value={num(bis.meanCappedIndex)}
          hint={`${num(bis.meanIndex)} before the cap`}
        />
        <Metric
          label="Average gap"
          value={num(bis.maeCapped, 2, " pts")}
          hint={`${num(bis.maeRaw, 2)} before the cap`}
        />
        <Metric
          label="Reads light / deep"
          value={num(bis.biasCapped, 2, " pts")}
          hint="Positive means COEBIS reads lighter than the monitor"
        />
        <Metric
          label="Within 5 points"
          value={pct(bis.within5, bis.n)}
          hint={`within 10: ${pct(bis.within10, bis.n)}`}
        />
      </CardContent>
    </Card>
  );
}

function EngineCard() {
  const m = COEBIS_V2_MODEL.meta;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">The depth model behind these traces</CardTitle>
        <CardDescription>
          Fitted on {m.cases} patients from{" "}
          <span className="font-mono">{m.lineage}</span>, graded by holding whole
          patients out of the fit.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Held-out gap"
          value={num(m.heldOutMae, 2, " pts")}
          hint={`the previous engine scored ${m.baselineMae.toFixed(2)}`}
        />
        <Metric label="Within 5 points" value={`${m.heldOutWithin5.toFixed(1)}%`} />
        <Metric label="Readings fitted on" value={m.rows.toLocaleString()} />
        <Metric label="Patients" value={String(m.cases)} />
      </CardContent>
    </Card>
  );
}

function DepthPage() {
  const load = useServerFn(getSuppressionDashboard);
  const [sort, setSort] = useState<"gap" | "readings">("gap");
  const { data, isLoading, error } = useQuery({
    queryKey: ["depth-dashboard"],
    queryFn: () => load({ data: { limit: 80000 } }),
    staleTime: 60_000,
  });

  const cases = [...(data?.cases ?? [])].sort((a, b) =>
    sort === "readings"
      ? b.bis.n - a.bis.n
      : (b.bis.maeCapped ?? -1) - (a.bis.maeCapped ?? -1),
  );

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="size-5 text-signal" /> Depth dashboard
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        The bedside monitor's own number, the recorded suppression ratio and the
        depth model, on one clock for each case. The monitor is the comparison
        here, not the truth: both can be wrong together, and neither replaces
        looking at the patient.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading paired readings…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load the readings."}
        </p>
      ) : !data ? null : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <PooledCard
              bis={data.bisTotals}
              patients={data.patients}
              casesWithBis={data.casesWithBis}
            />
            <EngineCard />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                Case by case
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto min-h-11 sm:min-h-8"
                  onClick={() => setSort(sort === "gap" ? "readings" : "gap")}
                >
                  Sorted by {sort === "gap" ? "widest gap" : "most readings"}
                </Button>
              </CardTitle>
              <CardDescription>
                Worst agreement first, so the cases to look at are at the top.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Case</TableHead>
                    <TableHead className="text-right">Readings</TableHead>
                    <TableHead className="text-right">BIS</TableHead>
                    <TableHead className="text-right">COEBIS</TableHead>
                    <TableHead className="text-right">Gap</TableHead>
                    <TableHead className="text-right">Within 5</TableHead>
                    <TableHead className="text-right">Monitor SR</TableHead>
                    <TableHead className="text-right">Suppression missed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map((c) => (
                    <TableRow key={c.caseRef}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          to="/case/$caseRef"
                          params={{ caseRef: c.caseRef }}
                          className="underline-offset-2 hover:underline"
                        >
                          {c.caseRef}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.bis.n.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(c.bis.meanBis)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(c.bis.meanCappedIndex)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(c.bis.maeCapped, 2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pct(c.bis.within5, c.bis.n)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(c.meanMonitorSr)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.flags.missed || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {cases.map((c) => (
            <CaseTraceCard key={c.caseRef} trace={c} />
          ))}
        </div>
      )}
    </main>
  );
}
