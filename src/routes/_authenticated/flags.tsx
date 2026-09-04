import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
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
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";

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
import { getSuppressionDashboard } from "@/lib/eeg/suppression-dashboard.functions";
import {
  APP_FLAG_PCT,
  type CaseTrace,
  type FlagAgreement,
  type GateStatus,
} from "@/lib/eeg/suppression-dashboard";
import { MONITOR_SUPPRESSED_PCT } from "@/lib/eeg/suppression-model";

export const Route = createFileRoute("/_authenticated/flags")({
  head: () => ({
    meta: [
      { title: "Suppression flags beside COEBIS — CortexTrace" },
      {
        name: "description",
        content:
          "Per-case traces putting the suppression flag and the COEBIS depth number on one clock, with the monitor's own suppression ratio, the capped depth score and the gate status for the suppression fit.",
      },
      { property: "og:title", content: "Suppression flags beside COEBIS — CortexTrace" },
      {
        property: "og:description",
        content:
          "Where the monitor recorded suppression, where the app raises its own flag, and what the bounded cap does to the depth number at those moments.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FlagsPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

const num = (v: number | null, dp = 1, suffix = ""): string =>
  v == null ? "—" : `${v.toFixed(dp)}${suffix}`;

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Agreement between the two flags, written as counts rather than a score. */
function FlagCounts({ flags }: { flags: FlagAgreement }) {
  const total = flags.agreed + flags.missed + flags.falseAlarms + flags.clear;
  const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : "—");
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Metric label="Both flagged" value={String(flags.agreed)} hint={pct(flags.agreed)} />
      <Metric
        label="Monitor only (missed)"
        value={String(flags.missed)}
        hint={`${pct(flags.missed)} · the dangerous miss`}
      />
      <Metric
        label="App only"
        value={String(flags.falseAlarms)}
        hint={`${pct(flags.falseAlarms)} · errs towards caution`}
      />
      <Metric label="Neither" value={String(flags.clear)} hint={pct(flags.clear)} />
    </div>
  );
}

function GateCard({ gate }: { gate: GateStatus }) {
  const rows: { label: string; have: number; need: number }[] = [
    { label: "Paired readings", have: gate.points, need: gate.requiredPoints },
    { label: "Cases", have: gate.cases, need: gate.requiredCases },
    {
      label: "Readings inside recorded suppression",
      have: gate.suppressedPoints,
      need: gate.requiredSuppressedPoints,
    },
  ];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Gate status · {gate.lineage}
          <Badge variant={gate.active ? "default" : "secondary"}>
            {gate.active ? "in force" : "not in force"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {gate.active
            ? `Cross-validated across ${gate.folds} folds; the flag catches ${num(
                gate.sensitivityGain == null ? null : gate.sensitivityGain * 100,
                1,
                " percentage points",
              )} more of the suppression the monitor recorded.`
            : (gate.blockedBy ?? "The suppression fit is not yet allowed to act.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{r.label}</span>
            <span className="tabular-nums">
              <span className={r.have >= r.need ? "text-success" : "text-critical"}>{r.have}</span>
              <span className="text-muted-foreground"> / {r.need}</span>
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** One case: the two scores on one clock, with the flags marked underneath. */
function CaseCard({ trace }: { trace: CaseTrace }) {
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
          <Badge variant="secondary">{trace.points} readings</Badge>
          <Badge variant="secondary">{minutes} min</Badge>
          {trace.flags.missed ? (
            <Badge variant="destructive">{trace.flags.missed} missed</Badge>
          ) : trace.flags.agreed ? (
            <Badge>suppression caught</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Monitor SR {num(trace.meanMonitorSr)}% · model estimate {num(trace.meanEstimatedSr)}% ·
          COEBIS {num(trace.meanIndex)} → {num(trace.meanCappedIndex)} after the cap ·
          {" "}
          {trace.capEngaged} readings capped, deepest pull {num(trace.maxCapShift)} points
          {trace.falselyLight
            ? ` · ${trace.falselyLight} readings still read light inside recorded suppression`
            : ""}
        </CardDescription>
        <CardDescription>
          {trace.bis.n
            ? `Against the monitor on ${trace.bis.n} readings: BIS ${num(
                trace.bis.meanBis,
              )} · COEBIS off by ${num(trace.bis.maeRaw)} points, ${num(
                trace.bis.maeCapped,
              )} after the cap (${trace.bis.capImproved} readings closer, ${
                trace.bis.capWorsened
              } further away)`
            : "No monitor index recorded on this case, so only suppression can be compared here."}
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
                label={{ value: "index / SR %", angle: -90, position: "insideLeft", fontSize: 10 }}
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
                dataKey="index"
                name="COEBIS"
                stroke="var(--color-signal, currentColor)"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />

              <Line
                type="monotone"
                dataKey="cappedIndex"
                name="COEBIS after cap"
                stroke="var(--color-critical, currentColor)"
                dot={false}
                strokeWidth={1.5}
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
                stroke="currentColor"
                strokeDasharray="3 3"
                strokeOpacity={0.8}
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
        <div className="mt-3">
          <FlagCounts flags={trace.flags} />
        </div>
      </CardContent>
    </Card>
  );
}

function FlagsPage() {
  const load = useServerFn(getSuppressionDashboard);
  const { data, isLoading, error } = useQuery({
    queryKey: ["suppression-dashboard"],
    queryFn: () => load({ data: {} }),
    staleTime: 60_000,
  });

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/suppression">
            <ArrowLeft className="size-4" /> Suppression model
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldAlert className="size-5 text-signal" /> Suppression flags beside COEBIS
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        The suppression flag and the depth number are fitted separately and are only ever read
        together through a bounded cap: suppression can pull COEBIS down, never push it up. Each
        case below puts both on one clock, with the monitor's own suppression ratio for comparison
        and the moments each flag was up marked along the bottom.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading paired suppression readings…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load the suppression readings."}
        </p>
      ) : !data ? null : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <GateCard gate={data.gate} />
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Flag agreement across the cases shown
                </CardTitle>
                <CardDescription>
                  Every reading counted once: the monitor's suppression ratio against the app's
                  estimate, at the same {MONITOR_SUPPRESSED_PCT}% threshold.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FlagCounts flags={data.totals} />
              </CardContent>
            </Card>
          </div>

          {data.cases.length ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.cases.map((trace) => (
                <CaseCard key={trace.caseRef} trace={trace} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No case carries both a monitor suppression ratio and a depth reading yet. Upload a
              monitor export on the reference library page to populate this view.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
