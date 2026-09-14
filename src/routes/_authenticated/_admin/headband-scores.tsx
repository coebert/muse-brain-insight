import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2, Waves } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { DEEP_INDEX, LIGHT_INDEX, MIN_GROUP_EPOCHS } from "@/lib/eeg/headband-depth-scores";
import { getHeadbandScores } from "@/lib/eeg/headband-depth-scores.functions";
import { unseal } from "@/lib/privacy";

export const Route = createFileRoute("/_authenticated/_admin/headband-scores")({
  head: () => ({
    meta: [
      { title: "Headband depth score — CortexTrace" },
      {
        name: "description",
        content:
          "The headband-only depth model's 0–100 scores set against the shared suppression model on the same recordings: where the two agree, where they contradict each other, and what the cap changes.",
      },
      { property: "og:title", content: "Headband depth score — CortexTrace" },
      {
        property: "og:description",
        content:
          "Headband-only depth scores checked against the independent suppression model, epoch by epoch.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HeadbandScoresPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

const pts = (v: number | null) => (v == null ? "—" : v.toFixed(1));
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function HeadbandScoresPage() {
  const fetchScores = useServerFn(getHeadbandScores);
  const report = useQuery({
    queryKey: ["headband-scores"],
    queryFn: async () => {
      const out = await fetchScores({ data: {} });
      const cases_ = (await unseal(
        out.cases_ as unknown as Record<string, unknown>[],
        ["caseCode"],
      )) as unknown as typeof out.cases_;
      return { ...out, cases_ };
    },
    staleTime: 60_000,
  });

  const data = report.data;

  return (
    <div className="min-h-dvh bg-background">
      <AppNav />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/models">
              <ArrowLeft className="mr-1 h-4 w-4" /> Models
            </Link>
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Waves className="h-5 w-5 text-primary" /> Headband depth score
            </h1>
            <p className="text-sm text-muted-foreground">
              The headband-only model scores every recorded epoch 0–100. The suppression model,
              fitted separately and never trained on that score, says how flat the same epoch was.
              Neither knows about the other, so where they land on the same moments is a real check.
            </p>
          </div>
        </div>

        {report.isLoading ? (
          <Card>
            <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Scoring the headband recordings…
            </CardContent>
          </Card>
        ) : !data || data.epochs === 0 ? (
          <Card>
            <CardContent className="py-10 text-sm text-muted-foreground">
              No scored headband epochs yet. Record a case on the bedside screen and its readings
              will appear here.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What the two models say together</CardTitle>
                <CardDescription>
                  {data.epochs.toLocaleString()} scored epochs across {data.cases} of{" "}
                  {data.recordings} headband recordings.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm">{data.verdict}</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Mean headband score" value={pts(data.meanIndex)} />
                  <Stat
                    label="Open index, same epochs"
                    value={pts(data.meanRaw)}
                    hint={
                      data.meanShift == null
                        ? undefined
                        : `${data.meanShift > 0 ? "+" : ""}${data.meanShift.toFixed(1)} points from the model`
                    }
                  />
                  <Stat
                    label="Epochs called suppressed"
                    value={data.suppressedEpochs.toLocaleString()}
                    hint="by the shared suppression model"
                  />
                  <Stat
                    label="Agreement where suppressed"
                    value={pct(data.concordance)}
                    hint={`score below ${DEEP_INDEX}`}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Contradictions"
                    value={pct(data.contradictionShare)}
                    hint={`flat record, score ${LIGHT_INDEX} or above`}
                  />
                  <Stat
                    label="Score vs suppression"
                    value={data.correlation == null ? "—" : data.correlation.toFixed(2)}
                    hint="negative means deeper score as the record flattens"
                  />
                  <Stat
                    label="Epochs the cap changed"
                    value={data.cappedEpochs.toLocaleString()}
                  />
                  <Stat label="Mean points removed" value={pts(data.meanCapShift)} />
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant={data.depthSource === "headband_model" ? "default" : "secondary"}>
                    {data.depthSource === "headband_model"
                      ? "Headband-only model applied"
                      : "No headband model promoted — open index shown"}
                  </Badge>
                  <Badge variant={data.suppressionSource === "promoted" ? "default" : "secondary"}>
                    {data.suppressionSource === "promoted"
                      ? "Promoted suppression model"
                      : "No suppression model promoted — app ratio shown"}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Score by what the record was doing</CardTitle>
                <CardDescription>
                  A depth score is only credible if it drops where the record goes flat. Groups
                  under {MIN_GROUP_EPOCHS} epochs are marked as too small to read.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.groups}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} height={48} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="meanIndex"
                        name="Mean headband score"
                        fill="hsl(var(--primary))"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="py-2 text-left font-medium">Group</th>
                        <th className="py-2 text-right font-medium">Epochs</th>
                        <th className="py-2 text-right font-medium">Recordings</th>
                        <th className="py-2 text-right font-medium">Mean score</th>
                        <th className="py-2 text-right font-medium">Open index</th>
                        <th className="py-2 text-right font-medium">Called deep</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.groups.map((g) => (
                        <tr key={g.label} className="border-b border-border/50">
                          <td className="py-2">
                            {g.label}
                            {!g.readable && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                too small to read
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right tabular-nums">{g.epochs}</td>
                          <td className="py-2 text-right tabular-nums">{g.cases}</td>
                          <td className="py-2 text-right tabular-nums">{pts(g.meanIndex)}</td>
                          <td className="py-2 text-right tabular-nums">{pts(g.meanRaw)}</td>
                          <td className="py-2 text-right tabular-nums">{pct(g.deepShare)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recording by recording</CardTitle>
                <CardDescription>
                  Contradictions are epochs the suppression model called flat while the headband
                  score still read light.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="py-2 text-left font-medium">Recording</th>
                      <th className="py-2 text-right font-medium">Epochs</th>
                      <th className="py-2 text-right font-medium">Mean score</th>
                      <th className="py-2 text-right font-medium">Open index</th>
                      <th className="py-2 text-right font-medium">Suppressed</th>
                      <th className="py-2 text-right font-medium">Contradictions</th>
                      <th className="py-2 text-right font-medium">Capped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cases_.map((c) => (
                      <tr key={c.sessionId} className="border-b border-border/50">
                        <td className="py-2 font-mono text-xs">
                          {c.caseCode ?? c.sessionId.slice(0, 8)}
                        </td>
                        <td className="py-2 text-right tabular-nums">{c.epochs}</td>
                        <td className="py-2 text-right tabular-nums">{pts(c.meanIndex)}</td>
                        <td className="py-2 text-right tabular-nums">{pts(c.meanRaw)}</td>
                        <td className="py-2 text-right tabular-nums">{c.suppressedEpochs}</td>
                        <td className="py-2 text-right tabular-nums">{c.contradictions}</td>
                        <td className="py-2 text-right tabular-nums">{c.capped}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
              The suppression model is not a depth reference: it says how flat the record was, not
              what the depth number should have been. Agreement here is corroboration between two
              independent readings of the same epoch, never a substitute for paired monitor
              readings.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
