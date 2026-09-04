import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, GitCompareArrows, Loader2, X } from "lucide-react";

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
import { getCaseFile } from "@/lib/eeg/case-file.functions";
import type { CaseComparison, CaseFile, CaseOption } from "@/lib/eeg/case-file";
import type { CaseTrace, ModelSource } from "@/lib/eeg/suppression-dashboard";
import type { KetamineCaseSummary } from "@/lib/eeg/ketamine-cases";
import { MONITOR_SUPPRESSED_PCT } from "@/lib/eeg/suppression-model";

export const Route = createFileRoute("/_authenticated/case/$caseRef")({
  validateSearch: (search: Record<string, unknown>): { vs?: string } => {
    const vs = typeof search["vs"] === "string" ? search["vs"].slice(0, 200) : undefined;
    return vs ? { vs } : {};
  },
  head: () => ({
    meta: [
      { title: "Case file: depth, suppression and ketamine — CortexTrace" },
      {
        name: "description",
        content:
          "One case read three ways at once: the COEBIS depth trace against the bedside monitor, the suppression flag and its cap, and the ketamine spectral signature, with any second case lined up beside it.",
      },
      {
        property: "og:title",
        content: "Case file: depth, suppression and ketamine — CortexTrace",
      },
      {
        property: "og:description",
        content:
          "Per-case view of the depth trace, suppression flag and ketamine signature, with a side-by-side comparison against another case.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CaseFilePage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => (
    <div className="p-6 text-sm text-muted-foreground">That case is not held in the app.</div>
  ),
});

const num = (v: number | null | undefined, dp = 1, suffix = ""): string =>
  v == null ? "—" : `${v.toFixed(dp)}${suffix}`;

function sourceLabel(source: ModelSource): string {
  return source === "promoted"
    ? "calibration in force"
    : source === "candidate fit"
      ? "candidate fit, not promoted"
      : "raw detector, no calibration in force";
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The depth trace: COEBIS, the capped number and the monitor on one clock. */
function DepthCard({ trace }: { trace: CaseTrace | null }) {
  if (!trace) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Depth trace</CardTitle>
          <CardDescription>
            No paired monitor reading is held for this case, so there is no depth trace to draw.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const data = trace.samples.map((s) => ({ ...s }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Depth trace</CardTitle>
        <CardDescription>
          {trace.bis.n
            ? `Against the monitor on ${trace.bis.n.toLocaleString()} readings: BIS ${num(
                trace.bis.meanBis,
              )}, COEBIS off by ${num(trace.bis.maeRaw)} points, ${num(
                trace.bis.maeCapped,
              )} after the cap.`
            : "No bedside index recorded on this case, so the depth number cannot be graded here."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Mean COEBIS" value={num(trace.meanIndex)} />
          <Metric label="After cap" value={num(trace.meanCappedIndex)} />
          <Metric label="Mean BIS" value={num(trace.bis.meanBis)} />
          <Metric
            label="Reads lighter by"
            value={num(trace.bis.biasRaw, 1, " pts")}
            hint={`${num(trace.bis.biasCapped, 1, " pts")} after the cap`}
          />
        </div>
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
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                stroke="currentColor"
                className="text-xs text-muted-foreground"
              />
              <Tooltip
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }}
                labelFormatter={(v: number) => `${Math.round(Number(v) / 60)} min into the case`}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
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
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** The suppression flag: monitor ratio, model estimate and flag agreement. */
function SuppressionCard({ trace, source }: { trace: CaseTrace | null; source: ModelSource }) {
  if (!trace) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Suppression flag</CardTitle>
          <CardDescription>
            No recorded suppression ratio is held for this case, so the flag cannot be graded.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const data = trace.samples.map((s) => ({ ...s }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Suppression flag</CardTitle>
        <CardDescription>
          Both flags read at {MONITOR_SUPPRESSED_PCT}%, using the {sourceLabel(source)}. The cap
          can pull COEBIS down at these moments, never push it up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Both flagged" value={trace.flags.agreed.toLocaleString()} />
          <Metric
            label="Monitor only"
            value={trace.flags.missed.toLocaleString()}
            hint="the dangerous miss"
          />
          <Metric
            label="App only"
            value={trace.flags.falseAlarms.toLocaleString()}
            hint="errs towards caution"
          />
          <Metric
            label="Readings capped"
            value={trace.capEngaged.toLocaleString()}
            hint={`deepest pull ${num(trace.maxCapShift)} points`}
          />
        </div>
        <div className="h-40 w-full">
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
                stroke="currentColor"
                className="text-xs text-muted-foreground"
                label={{ value: "SR %", angle: -90, position: "insideLeft", fontSize: 10 }}
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
                dataKey="monitorSr"
                name="Monitor SR %"
                stroke="var(--color-success, currentColor)"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="estimatedSr"
                name="Model estimate %"
                stroke="var(--color-signal, currentColor)"
                strokeDasharray="3 3"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {trace.falselyLight ? (
          <p className="text-xs text-critical">
            {trace.falselyLight} readings still read light inside recorded suppression.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const EFFECT_TEXT: Record<KetamineCaseSummary["effect"], string> = {
  correcting: "Ketamine recorded and the correction is moving the number on this case.",
  watched: "Ketamine recorded, but nothing in these epochs needed correcting.",
  advisory:
    "The fast-frequency pattern is present but ketamine is not recorded, so nothing is subtracted — advisory only.",
  quiet: "Neither a ketamine record nor the pattern; the correction is idle here.",
};

/** The ketamine signature and what the subtraction did to this case. */
function KetamineCard({ summary }: { summary: KetamineCaseSummary | null }) {
  if (!summary) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ketamine signature</CardTitle>
          <CardDescription>
            No spectra are held for this case, so its drug signature is unknown. This is not the
            same as a case with no ketamine.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Ketamine signature
          <Badge variant={summary.declared ? "default" : "secondary"}>
            {summary.declared ? "recorded" : "not recorded"}
          </Badge>
          <Badge variant={summary.effect === "advisory" ? "destructive" : "secondary"}>
            {summary.effect}
          </Badge>
        </CardTitle>
        <CardDescription>{EFFECT_TEXT[summary.effect]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label="13–47 Hz share"
            value={pct(summary.meanBetaGamma)}
            hint={`peak ${pct(summary.maxBetaGamma)}`}
          />
          <Metric label="Alpha spindle" value={pct(summary.meanAlpha)} />
          <Metric label="Slow wave" value={pct(summary.meanSlow)} />
          <Metric
            label="Pattern strength"
            value={summary.meanScore.toFixed(2)}
            hint={`${pct(summary.patternFraction)} of epochs above threshold`}
          />
          <Metric
            label="Epochs corrected"
            value={summary.correctedEpochs.toLocaleString()}
            hint={`of ${summary.epochs.toLocaleString()} held`}
          />
          <Metric
            label="Mean correction"
            value={num(summary.meanDelta, 1, " pts")}
            hint={`deepest ${num(summary.maxDelta, 1, " pts")}`}
          />
          <Metric
            label="Crossings"
            value={summary.crossings.toLocaleString()}
            hint="epochs the correction carries across the threshold"
          />
          <Metric
            label="Depth-state grade"
            value={summary.state.grade}
            hint={`separation ${num(summary.state.separation, 1, " pts")}`}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Suppression grade: {summary.suppression.grade}
          {summary.suppression.labelled
            ? ` on ${summary.suppression.labelled.toLocaleString()} labelled epochs (${num(
                summary.suppression.concordance == null
                  ? null
                  : summary.suppression.concordance * 100,
                1,
                "% agreement",
              )})`
            : " — no independently recorded suppression on this case"}
          .
        </p>
      </CardContent>
    </Card>
  );
}

/** One case across the three axes. */
function CaseColumn({ file, heading }: { file: CaseFile; heading?: string }) {
  return (
    <div className="space-y-4">
      {heading ? (
        <h2 className="font-mono text-sm font-semibold">
          {heading} <span className="text-muted-foreground">{file.caseRef}</span>
        </h2>
      ) : null}
      <DepthCard trace={file.trace} />
      <SuppressionCard trace={file.trace} source={file.modelSource} />
      <KetamineCard summary={file.ketamine} />
    </div>
  );
}

function fmt(v: number | null, unit: string): string {
  if (v == null) return "—";
  return unit === "percent" ? `${v.toFixed(1)}%` : unit === "count" ? v.toLocaleString() : v.toFixed(1);
}

function ComparisonTable({ comparison }: { comparison: CaseComparison }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Side by side</CardTitle>
        <CardDescription>
          A blank difference means one of the two cases carries no evidence on that measure — the
          two are not comparable there, and an absent label is never counted as a zero.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Measure</th>
              <th className="py-2 pr-3 font-mono font-medium">{comparison.a}</th>
              <th className="py-2 pr-3 font-mono font-medium">{comparison.b}</th>
              <th className="py-2 font-medium">Difference</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((r) => {
              const better =
                r.delta == null || r.higherIsBetter == null || r.delta === 0
                  ? null
                  : r.higherIsBetter === r.delta > 0;
              return (
                <tr key={r.label} className="border-b last:border-0">
                  <td className="py-2 pr-3 text-muted-foreground">{r.label}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmt(r.a, r.unit)}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmt(r.b, r.unit)}</td>
                  <td
                    className={`py-2 tabular-nums ${
                      better == null ? "" : better ? "text-success" : "text-critical"
                    }`}
                  >
                    {r.delta == null
                      ? "—"
                      : `${r.delta > 0 ? "+" : ""}${fmt(r.delta, r.unit)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {comparison.notes.length ? (
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {comparison.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ComparePicker({
  options,
  caseRef,
  vs,
}: {
  options: CaseOption[];
  caseRef: string;
  vs?: string;
}) {
  const navigate = useNavigate();
  const others = options.filter((o) => o.caseRef !== caseRef);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={vs ?? ""}
        onValueChange={(value) =>
          navigate({ to: "/case/$caseRef", params: { caseRef }, search: { vs: value } })
        }
      >
        <SelectTrigger className="min-h-11 w-64 sm:min-h-9">
          <GitCompareArrows className="size-4" />
          <SelectValue placeholder="Compare with another case" />
        </SelectTrigger>
        <SelectContent>
          {others.map((o) => (
            <SelectItem key={o.caseRef} value={o.caseRef}>
              {o.caseRef} · {o.points.toLocaleString()} readings
              {o.ketamineDeclared ? " · ketamine" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {vs ? (
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => navigate({ to: "/case/$caseRef", params: { caseRef }, search: {} })}
        >
          <X className="size-4" /> Clear comparison
        </Button>
      ) : null}
    </div>
  );
}

function CaseFilePage() {
  const { caseRef } = Route.useParams();
  const { vs } = Route.useSearch();
  const load = useServerFn(getCaseFile);
  const { data, isLoading, error } = useQuery({
    queryKey: ["case-file", caseRef, vs ?? null],
    queryFn: () => load({ data: vs ? { caseRef, vs } : { caseRef } }),
    staleTime: 60_000,
  });

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/flags">
            <ArrowLeft className="size-4" /> All cases
          </Link>
        </Button>
        <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
          <span className="truncate font-mono">{caseRef}</span>
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        The depth number, the suppression flag and the ketamine signature come from three separate
        fits that never share data. They are shown together here so one case can be read as a
        whole, not so the three can be traded off against each other.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading this case…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load this case."}
        </p>
      ) : !data ? null : (
        <div className="space-y-4">
          <ComparePicker options={data.options} caseRef={caseRef} {...(vs ? { vs } : {})} />

          {!data.primary.trace && !data.primary.ketamine ? (
            <p className="text-sm text-muted-foreground">
              Nothing is held for this case yet. Pick another from the list above, or upload a
              monitor export on the{" "}
              <Link className="underline" to="/reference">
                reference library
              </Link>{" "}
              page.
            </p>
          ) : null}

          {data.comparison ? <ComparisonTable comparison={data.comparison} /> : null}

          {data.secondary ? (
            <div className="grid gap-6 xl:grid-cols-2">
              <CaseColumn file={data.primary} heading="This case" />
              <CaseColumn file={data.secondary} heading="Compared with" />
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-3">
              <DepthCard trace={data.primary.trace} />
              <SuppressionCard trace={data.primary.trace} source={data.primary.modelSource} />
              <KetamineCard summary={data.primary.ketamine} />
            </div>
          )}
        </div>
      )}
    </main>
  );
}
