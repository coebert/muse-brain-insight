import { useMemo, useState } from "react";
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
import { ArrowLeft, Loader2, Users } from "lucide-react";

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getPatientScores } from "@/lib/eeg/patient-scores.functions";
import {
  MIN_CASE_READINGS,
  SUPPRESSION_PCT_THRESHOLD,
  type PatientScoreRow,
} from "@/lib/eeg/patient-scores";

export const Route = createFileRoute("/_authenticated/patients")({
  head: () => ({
    meta: [
      { title: "Patient scoreboard — CortexTrace" },
      {
        name: "description",
        content:
          "COEBIS depth scores per patient alongside suppression burden, SEF95 and age, compared case by case against the recorded BIS or clinical depth reference.",
      },
      { property: "og:title", content: "Patient scoreboard — CortexTrace" },
      {
        property: "og:description",
        content:
          "Per-case COEBIS versus the recorded depth reference, with the suppression and spectral-edge context needed to read the agreement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PatientsPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

type SortKey = "recent" | "mae" | "suppression" | "readings" | "sef";

const num = (v: number | null | undefined, dp = 1, unit = ""): string =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(dp)}${unit}`;

function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function ReferenceBadge({ row }: { row: PatientScoreRow }) {
  return (
    <Badge
      variant="outline"
      className={
        row.reference.isMonitor
          ? "border-signal/30 bg-signal/15 text-signal"
          : "border-amber-500/30 bg-amber-500/15 text-amber-500"
      }
    >
      {row.reference.isMonitor ? `BIS · ${row.reference.label}` : row.reference.label}
    </Badge>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 font-mono text-2xl">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function CaseDetail({ row }: { row: PatientScoreRow }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{row.caseLabel}</CardTitle>
            <CardDescription className="truncate">
              {row.lineageKey}
              {row.modelVersion == null ? " · no model" : ` · COEBIS v${row.modelVersion}`}
            </CardDescription>
          </div>
          <ReferenceBadge row={row} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{row.reference.note}</p>
        <div className="h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={row.series} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
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
                yAxisId="index"
                domain={[0, 100]}
                stroke="currentColor"
                className="text-xs text-muted-foreground"
                label={{ value: "index / SR %", angle: -90, position: "insideLeft", fontSize: 10 }}
              />
              <YAxis
                yAxisId="hz"
                orientation="right"
                domain={[0, 30]}
                stroke="currentColor"
                className="text-xs text-muted-foreground"
                label={{ value: "SEF95 Hz", angle: 90, position: "insideRight", fontSize: 10 }}
              />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                labelFormatter={(v: number) => `${Math.round(Number(v) / 60)} min into the case`}
              />
              <Legend />
              <Area
                yAxisId="index"
                type="monotone"
                dataKey="sr"
                name="Suppression ratio %"
                stroke="hsl(var(--critical))"
                fill="hsl(var(--critical))"
                fillOpacity={0.12}
                strokeOpacity={0.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                yAxisId="index"
                type="monotone"
                dataKey="reference"
                name={row.reference.isMonitor ? "Recorded BIS" : "Reference"}
                stroke="hsl(var(--signal))"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
              <Line
                yAxisId="index"
                type="monotone"
                dataKey="coebis"
                name="COEBIS"
                stroke="hsl(var(--primary))"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                yAxisId="index"
                type="monotone"
                dataKey="raw"
                name="Open index"
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="hz"
                type="monotone"
                dataKey="sef"
                name="SEF95 (Hz)"
                stroke="hsl(var(--accent-foreground))"
                strokeDasharray="2 3"
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="h-32 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={row.series} margin={{ top: 4, right: 8, bottom: 4, left: 0 }} syncId={row.caseKey}>
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
                domain={[-40, 40]}
                stroke="currentColor"
                className="text-xs text-muted-foreground"
                label={{ value: "gap", angle: -90, position: "insideLeft", fontSize: 10 }}
              />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                labelFormatter={(v: number) => `${Math.round(Number(v) / 60)} min into the case`}
              />
              <ReferenceLine y={0} stroke="hsl(var(--signal))" />
              <ReferenceLine y={10} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <ReferenceLine y={-10} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="gap"
                name={`${row.divergence.source === "coebis" ? "COEBIS" : "Open index"} − reference`}
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))"
                fillOpacity={0.2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted-foreground">
          Upper panel shares one 0–100 axis for the index traces and the app's suppression ratio in
          percent; SEF95 is read on the right-hand hertz axis. The lower panel is the same reading
          minus the reference, so a departure from the zero line is a divergence — dashed lines mark
          ±10 points. Positive means the app reads lighter than the reference.
        </p>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Readings</dt>
            <dd className="font-mono">
              {row.readings.toLocaleString()} over {durationText(row.spanSeconds)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Age</dt>
            <dd className="font-mono">
              {row.age.years != null
                ? `${row.age.years} y`
                : row.age.band
                  ? row.age.band
                  : "not published"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Sex / regimen</dt>
            <dd className="font-mono">
              {row.sex ?? "—"} / {row.regimen ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">COEBIS range</dt>
            <dd className="font-mono">
              {num(row.coebis.min, 0)}–{num(row.coebis.max, 0)} (median {num(row.coebis.median, 0)})
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Reference range</dt>
            <dd className="font-mono">
              {num(row.referenceSpread.min, 0)}–{num(row.referenceSpread.max, 0)} (median{" "}
              {num(row.referenceSpread.median, 0)})
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Suppression</dt>
            <dd className="font-mono">
              mean {num(row.suppression.meanPct, 1, "%")} · peak {num(row.suppression.maxPct, 1, "%")} ·{" "}
              {num(row.suppression.burdenPct, 0, "%")} of readings ≥{SUPPRESSION_PCT_THRESHOLD}%
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">SEF95</dt>
            <dd className="font-mono">
              {num(row.sef95.app.median, 1, " Hz")} (p10 {num(row.sef95.app.p10, 1)} · p90{" "}
              {num(row.sef95.app.p90, 1)})
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Agreement</dt>
            <dd className="font-mono">
              MAE {num(row.agreement?.mae, 1)} · bias {num(row.agreement?.bias, 1)} · within 10{" "}
              {num(row.agreement?.within10, 0, "%")}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{row.verdict}</p>
      </CardContent>
    </Card>
  );
}

function PatientsPage() {
  const load = useServerFn(getPatientScores);
  const { data, isPending, error } = useQuery({
    queryKey: ["patient-scores"],
    queryFn: () => load(),
  });

  const [lineage, setLineage] = useState("all");
  const [referenceFilter, setReferenceFilter] = useState<"all" | "monitor" | "annotation">("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const filtered = all.filter(
      (r) =>
        (lineage === "all" || r.lineageKey === lineage) &&
        (referenceFilter === "all" ||
          (referenceFilter === "monitor" ? r.reference.isMonitor : !r.reference.isMonitor)),
    );
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case "mae":
          return (b.agreement?.mae ?? b.raw.mae ?? 0) - (a.agreement?.mae ?? a.raw.mae ?? 0);
        case "suppression":
          return (b.suppression.burdenPct ?? 0) - (a.suppression.burdenPct ?? 0);
        case "readings":
          return b.readings - a.readings;
        case "sef":
          return (a.sef95.app.median ?? 99) - (b.sef95.app.median ?? 99);
        default:
          return a.lastAt < b.lastAt ? 1 : -1;
      }
    });
    return sorted;
  }, [data, lineage, referenceFilter, sort]);

  const active = rows.find((r) => r.caseKey === selected) ?? rows[0] ?? null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeft className="mr-1 size-4" /> Monitor
            </Link>
          </Button>
          <AppNav showBrand={false} compact />
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <div className="flex items-start gap-3">
          <Users className="mt-1 size-6 shrink-0 text-signal" />
          <div>
            <h1 className="text-2xl font-semibold">Patient scoreboard</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              One row per case: what COEBIS reported, against that case's own recorded reference,
              with the suppression burden and spectral edge you need to read the comparison. Cases
              are never pooled and references are never mixed — only rows badged{" "}
              <span className="text-signal">BIS</span> are a comparison against a bedside monitor.
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-critical">
            {(error as Error).message}
          </p>
        ) : null}

        {isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading paired readings…
          </p>
        ) : !data ? null : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Cases"
                value={data.rows.length.toLocaleString()}
                hint={`${data.totalReadings.toLocaleString()} paired readings`}
              />
              <StatCard
                label="Against a real BIS monitor"
                value={data.monitorCases.toLocaleString()}
                hint={`${data.annotationCases.toLocaleString()} scored against a clinical annotation instead`}
              />
              <StatCard
                label="Median per-case MAE"
                value={data.medianMae == null ? "—" : data.medianMae.toFixed(1)}
                hint={`across cases with a live model and ≥${MIN_CASE_READINGS} readings`}
              />
              <StatCard
                label="Cases reaching suppression"
                value={data.casesWithSuppression.toLocaleString()}
                hint={`any reading ≥${SUPPRESSION_PCT_THRESHOLD}% SR; ${data.casesWithAge} case${data.casesWithAge === 1 ? "" : "s"} carry an age`}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Select value={lineage} onValueChange={setLineage}>
                <SelectTrigger className="w-[280px]">
                  <SelectValue placeholder="All setups" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All acquisition setups</SelectItem>
                  {data.lineages.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={referenceFilter}
                onValueChange={(v) => setReferenceFilter(v as typeof referenceFilter)}
              >
                <SelectTrigger className="w-[240px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any reference</SelectItem>
                  <SelectItem value="monitor">Recorded BIS monitor only</SelectItem>
                  <SelectItem value="annotation">Clinical annotation only</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recent">Most recent first</SelectItem>
                  <SelectItem value="mae">Worst agreement first</SelectItem>
                  <SelectItem value="suppression">Most suppression first</SelectItem>
                  <SelectItem value="readings">Most readings first</SelectItem>
                  <SelectItem value="sef">Lowest SEF95 first</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {rows.length.toLocaleString()} case{rows.length === 1 ? "" : "s"}
                </CardTitle>
                <CardDescription>
                  COEBIS and reference values are medians over the case. Select a row to see the
                  full trace.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full min-w-[1000px] text-sm">
                  <thead className="border-b border-border/60 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Case</th>
                      <th className="px-4 py-2 font-medium">Reference</th>
                      <th className="px-4 py-2 font-medium">Age</th>
                      <th className="px-4 py-2 text-right font-medium">n</th>
                      <th className="px-4 py-2 text-right font-medium">COEBIS</th>
                      <th className="px-4 py-2 text-right font-medium">Reference</th>
                      <th className="px-4 py-2 text-right font-medium">Bias</th>
                      <th className="px-4 py-2 text-right font-medium">MAE</th>
                      <th className="px-4 py-2 text-right font-medium">±10</th>
                      <th className="px-4 py-2 text-right font-medium">SR mean / peak</th>
                      <th className="px-4 py-2 text-right font-medium">SEF95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const isActive = active?.caseKey === row.caseKey;
                      return (
                        <tr
                          key={row.caseKey}
                          onClick={() => setSelected(row.caseKey)}
                          className={`cursor-pointer border-b border-border/40 last:border-0 hover:bg-muted/40 ${
                            isActive ? "bg-muted/60" : ""
                          }`}
                        >
                          <td className="px-4 py-2">
                            <div className="max-w-[220px] truncate font-medium">{row.caseLabel}</div>
                            <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                              {row.lineageKey}
                              {row.modelVersion == null ? " · no model" : ` · v${row.modelVersion}`}
                              {row.sufficient ? "" : " · thin"}
                            </div>
                          </td>
                          <td className="px-4 py-2">
                            <ReferenceBadge row={row} />
                          </td>
                          <td className="px-4 py-2 text-xs">
                            {row.age.years != null
                              ? `${row.age.years} y`
                              : row.age.band
                                ? row.age.band
                                : <span className="text-muted-foreground">not published</span>}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {row.readings.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {num(row.coebis.median, 0)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {num(row.referenceSpread.median, 0)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {num(row.agreement?.bias ?? row.raw.bias, 1)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {num(row.agreement?.mae ?? row.raw.mae, 1)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono">
                            {num(row.agreement?.within10 ?? row.raw.within10, 0, "%")}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {num(row.suppression.meanPct, 1)} / {num(row.suppression.maxPct, 1)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {num(row.sef95.app.median, 1)}
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-4 py-6 text-center text-sm text-muted-foreground">
                          No cases match this filter.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {active ? <CaseDetail row={active} /> : null}

            <p className="text-xs text-muted-foreground">
              Cases with fewer than {MIN_CASE_READINGS} readings are marked “thin”: their agreement
              figures describe a few seconds, not a case. Where a lineage has no promoted model the
              table shows the open index instead of a COEBIS score, and says so.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
