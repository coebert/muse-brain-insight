import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Activity, GraduationCap, History, Sliders } from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LineageHistory } from "@/lib/eeg/training-history";
import { getFoldScores, getTrainingHistory } from "@/lib/eeg/training-history.functions";

export const Route = createFileRoute("/_authenticated/training")({
  head: () => ({
    meta: [
      { title: "Refit training history — CortexTrace" },
      {
        name: "description",
        content:
          "Settings each COEBIS refit ran under, held-out error for every fitted version in order, and per-patient fold scores for any acquisition setup.",
      },
      { property: "og:title", content: "Refit training history — CortexTrace" },
      {
        property: "og:description",
        content:
          "How the depth model has changed over successive refits: hyperparameters, error history per version, and leave-one-case-out fold scores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TrainingPage,
});

const fmt = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);

function LineageCard({
  lineage,
  onInspect,
  inspecting,
}: {
  lineage: LineageHistory;
  onInspect: () => void;
  inspecting: boolean;
}) {
  const series = lineage.versions.map((v) => ({
    version: `v${v.version}`,
    error: v.maeAfter,
    before: v.maeBefore,
    promoted: v.promoted ? v.maeAfter : null,
  }));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{lineage.lineageKey}</CardTitle>
            <CardDescription>
              {lineage.versions.length} fit{lineage.versions.length === 1 ? "" : "s"} on record ·{" "}
              {lineage.promotions} promoted · latest fit used{" "}
              {lineage.latestReadings.toLocaleString()} readings across {lineage.latestCases} cases.
              {lineage.activeVersion
                ? ` Live model is v${lineage.activeVersion} at ${fmt(lineage.activeMae)} points held out.`
                : " No model in force for this setup."}
            </CardDescription>
          </div>
          <Button size="sm" variant={inspecting ? "default" : "outline"} onClick={onInspect}>
            Fold scores
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {series.length > 1 ? (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="version" tick={{ fontSize: 11 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  label={{
                    value: "held-out error",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 11 },
                  }}
                />
                <Tooltip />
                {lineage.bestMae != null ? (
                  <ReferenceLine y={lineage.bestMae} strokeDasharray="4 4" className="stroke-muted-foreground" />
                ) : null}
                <Line
                  type="monotone"
                  dataKey="before"
                  name="model in force at the time"
                  dot={false}
                  strokeWidth={1.5}
                  className="stroke-muted-foreground"
                  stroke="currentColor"
                />
                <Line
                  type="monotone"
                  dataKey="error"
                  name="candidate held out"
                  strokeWidth={2}
                  className="stroke-primary"
                  stroke="currentColor"
                />
                <Scatter dataKey="promoted" name="promoted" className="fill-primary" fill="currentColor" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only one fit on record, so there is no trend to draw yet.
          </p>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Readings</TableHead>
                <TableHead className="text-right">Folds</TableHead>
                <TableHead className="text-right">Before</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead className="text-right">Gain</TableHead>
                <TableHead className="text-right">Within 5</TableHead>
                <TableHead className="text-right">Bias</TableHead>
                <TableHead className="text-right">Terms</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...lineage.versions].reverse().map((v) => (
                <TableRow key={v.version}>
                  <TableCell className="font-medium">
                    v{v.version}
                    <div className="text-xs text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {v.readings.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{v.folds}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(v.maeBefore)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(v.maeAfter)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(v.maeGain)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {v.within5After == null ? "—" : `${fmt(v.within5After, 1)}%`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(v.biasAfter)}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.terms}</TableCell>
                  <TableCell className="max-w-sm">
                    {v.isActive ? (
                      <Badge>In force</Badge>
                    ) : v.promoted ? (
                      <Badge variant="secondary">Promoted</Badge>
                    ) : (
                      <Badge variant="outline">Kept as record</Badge>
                    )}
                    {v.reason ? (
                      <div className="mt-1 text-xs text-muted-foreground">{v.reason}</div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function FoldPanel({ lineageKey }: { lineageKey: string }) {
  const fetchFolds = useServerFn(getFoldScores);
  const folds = useQuery({
    queryKey: ["coebis-folds", lineageKey],
    queryFn: () => fetchFolds({ data: { lineageKey } }),
  });

  const report = folds.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4" /> Fold scores — {lineageKey}
        </CardTitle>
        <CardDescription>
          Each fold holds one whole patient out of the fit and scores the model on that patient
          alone. This is the closest thing this pipeline has to per-epoch scores: the model is solved
          in one step, so the spread across patients — not a loss curve — is what shows where it
          struggles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {folds.isLoading ? (
          <p className="text-sm text-muted-foreground">Scoring every patient in this setup…</p>
        ) : folds.isError ? (
          <p className="text-sm text-destructive">Could not score this setup.</p>
        ) : !report || !report.folds.length ? (
          <p className="text-sm text-muted-foreground">
            No readings on file for this setup, so there is nothing to score.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "On its own data", value: fmt(report.inSampleMae) },
                { label: "On unseen patients", value: fmt(report.outOfSampleMae) },
                { label: "Optimism", value: fmt(report.optimism) },
                { label: "Median patient", value: fmt(report.median) },
              ].map((s) => (
                <div key={s.label} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="text-xl font-semibold tabular-nums">{s.value}</div>
                </div>
              ))}
            </div>

            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={report.folds.map((f, i) => ({ rank: i + 1, mae: f.mae, label: f.label }))}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="rank" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  {report.outOfSampleMae != null ? (
                    <ReferenceLine
                      y={report.outOfSampleMae}
                      strokeDasharray="4 4"
                      className="stroke-muted-foreground"
                    />
                  ) : null}
                  <Line
                    type="monotone"
                    dataKey="mae"
                    name="held-out error for that patient"
                    dot={false}
                    strokeWidth={2}
                    className="stroke-primary"
                    stroke="currentColor"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Patient held out</TableHead>
                    <TableHead className="text-right">Readings</TableHead>
                    <TableHead className="text-right">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.folds.slice(0, 40).map((f) => (
                    <TableRow key={f.caseKey}>
                      <TableCell className="font-medium">{f.label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.n.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(f.mae)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {report.folds.length > 40 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the 40 hardest of {report.folds.length} patients.
                </p>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TrainingPage() {
  const fetchHistory = useServerFn(getTrainingHistory);
  const history = useQuery({ queryKey: ["training-history"], queryFn: () => fetchHistory() });
  const [inspect, setInspect] = useState<string | null>(null);

  const data = history.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GraduationCap className="size-6" /> Refit training history
        </h1>
        <p className="text-sm text-muted-foreground">
          Everything the depth model has learned, in the order it learned it. COEBIS is fitted in one
          step rather than trained epoch by epoch, so there is no descending loss curve to show:
          instead each refit contributes one point to the error history below, and each patient held
          out of a fit contributes one fold score. Every number here is measured on patients the fit
          never saw.
        </p>
      </div>

      {history.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading training history…</p>
      ) : history.isError ? (
        <p className="text-sm text-destructive">Could not load training history.</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sliders className="size-4" /> Settings every refit runs under
          </CardTitle>
          <CardDescription>
            These are fixed for all setups, so two fits are always comparable.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Setting</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>What it does</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.hyperparameters ?? []).map((h) => (
                <TableRow key={h.name}>
                  <TableCell className="font-medium whitespace-nowrap">{h.name}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{h.value}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(data?.lineages ?? []).map((l) => (
        <LineageCard
          key={l.lineageKey}
          lineage={l}
          inspecting={inspect === l.lineageKey}
          onInspect={() => setInspect(inspect === l.lineageKey ? null : l.lineageKey)}
        />
      ))}

      {inspect ? <FoldPanel lineageKey={inspect} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4" /> Refit runs
          </CardTitle>
          <CardDescription>
            Each run looks at every setup with new readings and fits the ones that changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Readings used</TableHead>
                <TableHead className="text-right">Setups fitted</TableHead>
                <TableHead className="text-right">Promoted</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.runs ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(r.startedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{r.trigger}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "completed" ? "secondary" : "outline"}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.validatedPoints.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.lineagesRefitted} / {r.lineagesConsidered}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.modelsPromoted}</TableCell>
                  <TableCell className="max-w-sm text-xs text-muted-foreground">
                    {r.summary ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
