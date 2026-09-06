import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, GitCompare, Loader2 } from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
import { MIN_ARM } from "@/lib/eeg/case-outcomes";
import { getOutcomeCohort } from "@/lib/eeg/case-outcomes.functions";
import { getLineageComparison } from "@/lib/eeg/lineage-comparison.functions";
import {
  buildDepthArms,
  depthVerdict,
  outcomeBars,
  suppressionScore,
  type DepthArm,
} from "@/lib/eeg/model-comparison";
import { getSuppressionDashboard } from "@/lib/eeg/suppression-dashboard.functions";

export const Route = createFileRoute("/_authenticated/_admin/model-compare")({
  head: () => ({
    meta: [
      { title: "Model comparison — CortexTrace" },
      {
        name: "description",
        content:
          "The shared depth model, the headband-only model and the outcome cohort side by side: gap to the monitor, suppression agreement and what each level of exposure was followed by.",
      },
      { property: "og:title", content: "Model comparison — CortexTrace" },
      {
        property: "og:description",
        content:
          "Depth accuracy, suppression agreement and outcome separation for every model in force.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ModelComparePage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">Nothing to compare yet.</div>,
});

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const pctRaw = (v: number | null) => (v == null ? "—" : `${Math.round(v)}%`);
const pts = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}`);
const mins = (v: number | null) => (v == null ? "—" : `${Math.round(v)} min`);

const CHART_AXIS = { stroke: "hsl(var(--muted-foreground))", fontSize: 11 };
const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
};

function ArmCard({ arm }: { arm: DepthArm }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm">{arm.label}</CardTitle>
          <Badge variant={arm.readable ? "secondary" : "outline"}>
            {arm.readable ? "readable" : "too few readings"}
          </Badge>
        </div>
        <CardDescription>
          {arm.points.toLocaleString()} paired readings · {arm.cases} cases ·{" "}
          {arm.modelled} of {arm.lineages.length} setups have a fitted model
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-md bg-muted/40 p-2">
          <p className="text-xs text-muted-foreground">Gap to the monitor</p>
          <p className="text-2xl font-semibold tabular-nums">{pts(arm.modelMae)}</p>
          <p className="text-xs text-muted-foreground">
            open index {pts(arm.rawMae)} · {arm.gain == null
              ? "not comparable"
              : arm.gain > 0
                ? `${arm.gain.toFixed(2)} better`
                : `${Math.abs(arm.gain).toFixed(2)} worse`}
          </p>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <p className="text-xs text-muted-foreground">Within 5 points</p>
          <p className="text-2xl font-semibold tabular-nums">{pctRaw(arm.within5)}</p>
          <p className="text-xs text-muted-foreground">
            within 10 {pctRaw(arm.within10)} · reads{" "}
            {arm.bias == null
              ? "at an unknown offset"
              : `${Math.abs(arm.bias).toFixed(1)} points ${arm.bias > 0 ? "lighter" : "deeper"}`}
          </p>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Setups: {arm.lineages.length ? arm.lineages.join(", ") : "none recorded"}
        </p>
      </CardContent>
    </Card>
  );
}

function ModelComparePage() {
  const fetchLineages = useServerFn(getLineageComparison);
  const fetchSuppression = useServerFn(getSuppressionDashboard);
  const fetchCohort = useServerFn(getOutcomeCohort);

  const lineageQuery = useQuery({
    queryKey: ["lineage-comparison"],
    queryFn: () => fetchLineages(),
  });
  const suppressionQuery = useQuery({
    queryKey: ["suppression-dashboard", "compare"],
    queryFn: () => fetchSuppression({ data: { cases: 6 } }),
  });
  const cohortQuery = useQuery({ queryKey: ["outcome-cohort"], queryFn: () => fetchCohort() });

  const arms = useMemo(
    () => buildDepthArms(lineageQuery.data?.lineages ?? []),
    [lineageQuery.data],
  );
  const supp = useMemo(
    () => suppressionScore(suppressionQuery.data ?? null),
    [suppressionQuery.data],
  );
  const bars = useMemo(
    () => outcomeBars(cohortQuery.data?.contrasts ?? []),
    [cohortQuery.data],
  );

  const depthChart = arms.map((a) => ({
    name: a.key === "shared" ? "Shared" : "Headband",
    model: a.modelMae ?? 0,
    open: a.rawMae ?? 0,
  }));
  const withinChart = arms.map((a) => ({
    name: a.key === "shared" ? "Shared" : "Headband",
    within5: a.within5 == null ? 0 : Math.round(a.within5),
    within10: a.within10 == null ? 0 : Math.round(a.within10),
  }));
  const flagChart = [
    { name: "Caught", value: supp.caught },
    { name: "Missed", value: supp.missed },
  ];

  const loading =
    lineageQuery.isLoading || suppressionQuery.isLoading || cohortQuery.isLoading;

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/models">
            <ArrowLeft className="mr-1 h-4 w-4" /> Models
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <GitCompare className="h-5 w-5 text-signal" /> Model comparison
        </h1>
      </header>
      <AppNav />

      <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
        Three separate things, never merged into one score: the shared depth model fitted on the
        research recordings, the headband-only model fitted on the Muse and Regul8 readings alone,
        and the outcome cohort, which says nothing about accuracy but shows what each level of
        exposure was followed by. Every figure carries the number of readings behind it.
      </p>

      {loading && (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the paired recordings…
        </p>
      )}

      <section className="mt-6 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Depth
        </h2>
        <p className="max-w-3xl text-sm">{depthVerdict(arms)}</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {arms.map((arm) => (
            <ArmCard key={arm.key} arm={arm} />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Gap to the monitor</CardTitle>
              <CardDescription>Index points, lower is better</CardDescription>
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={depthChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" {...CHART_AXIS} />
                  <YAxis {...CHART_AXIS} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="open" name="Open index" fill="hsl(var(--muted-foreground))" />
                  <Bar dataKey="model" name="Fitted model" fill="hsl(var(--signal))" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Readings close to the monitor</CardTitle>
              <CardDescription>Percentage within 5 and 10 index points</CardDescription>
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={withinChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" {...CHART_AXIS} />
                  <YAxis domain={[0, 100]} unit="%" {...CHART_AXIS} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="within5" name="Within 5" fill="hsl(var(--signal))" />
                  <Bar dataKey="within10" name="Within 10" fill="hsl(var(--muted-foreground))" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mt-8 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Suppression
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The suppression flag is fitted once and shared by both depth models; the headband has no
          separate suppression fit, so these figures apply to either index.
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Against the monitor's own suppression</CardTitle>
              <CardDescription>
                {supp.n.toLocaleString()} readings · {supp.monitorEvents.toLocaleString()}{" "}
                suppressed moments
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="rounded-md bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">Suppression caught</p>
                <p className="text-2xl font-semibold tabular-nums">{pct(supp.sensitivity)}</p>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">False alarms</p>
                <p className="text-2xl font-semibold tabular-nums">{pct(supp.falseAlarmRate)}</p>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">Depth gap after the cap</p>
                <p className="text-2xl font-semibold tabular-nums">{pts(supp.cappedMae)}</p>
                <p className="text-xs text-muted-foreground">before {pts(supp.rawMae)}</p>
              </div>
              <div className="rounded-md bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">Flags in agreement</p>
                <p className="text-2xl font-semibold tabular-nums">{pct(supp.agreement)}</p>
              </div>
              {!supp.readable && (
                <p className="text-xs text-warning sm:col-span-2">
                  Fewer than 20 recorded suppressed moments — not readable as a performance figure
                  yet.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Suppressed moments</CardTitle>
              <CardDescription>Caught by the app versus missed</CardDescription>
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={flagChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" {...CHART_AXIS} />
                  <YAxis {...CHART_AXIS} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="value" name="Readings">
                    {flagChart.map((row) => (
                      <Cell
                        key={row.name}
                        fill={
                          row.name === "Missed"
                            ? "hsl(var(--critical))"
                            : "hsl(var(--signal))"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mt-8 space-y-4 pb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Outcome
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Neither model is graded here — this shows how much deeper and more suppressed the
          recordings were in patients who went on to need intensive care, a long stay, or who died
          in hospital. It takes no account of how sick the patient was or how big the operation.
        </p>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Exposure by what happened next</CardTitle>
            <CardDescription>
              {(cohortQuery.data?.casesWithOutcome ?? 0).toLocaleString()} recordings with a
              confirmed outcome
            </CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" {...CHART_AXIS} />
                <YAxis unit="m" {...CHART_AXIS} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="withDeep" name="Deep — outcome happened" fill="hsl(var(--signal))" />
                <Bar
                  dataKey="withoutDeep"
                  name="Deep — it did not"
                  fill="hsl(var(--muted-foreground))"
                />
                <Bar
                  dataKey="withSuppressed"
                  name="Suppressed — outcome happened"
                  fill="hsl(var(--critical))"
                />
                <Bar
                  dataKey="withoutSuppressed"
                  name="Suppressed — it did not"
                  fill="hsl(var(--border))"
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3">
          {bars.map((bar) => (
            <div key={bar.label} className="rounded-lg border border-border/60 bg-card p-3">
              <p className="text-sm font-medium">{bar.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {bar.withN} yes · {bar.withoutN} no
              </p>
              <p className="mt-2 text-sm">
                Deep {mins(bar.withDeep)} vs {mins(bar.withoutDeep)}
              </p>
              <p className="text-sm">
                Suppressed {mins(bar.withSuppressed)} vs {mins(bar.withoutSuppressed)}
              </p>
              {bar.underpowered && (
                <p className="mt-2 text-xs text-warning">
                  Fewer than {MIN_ARM} recordings in one arm — not readable yet.
                </p>
              )}
            </div>
          ))}
          {!bars.length && !loading && (
            <p className="text-sm text-muted-foreground">
              No recordings with confirmed outcomes yet.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
