import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Brain, Loader2 } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getPathologyLabels } from "@/lib/eeg/pathology-labels.functions";
import {
  SCORE_META,
  cnsLabelText,
  posteriorAtPrior,
  type LabelAxis,
  type ScoreDiscrimination,
  type Sufficiency,
} from "@/lib/eeg/pathology-labels";

export const Route = createFileRoute("/_authenticated/_admin/pathology")({
  head: () => ({
    meta: [
      { title: "Pathology validation — CortexTrace" },
      {
        name: "description",
        content:
          "Grade COEBIS, seizure score, suppression and SEF95 against recorded seizure and CNS disease labels, with suppression strata and prior-adjusted predictive value.",
      },
      { property: "og:title", content: "Pathology validation — CortexTrace" },
      {
        property: "og:description",
        content:
          "How well the depth index and seizure detector separate independently labelled seizure and CNS disease, at a stated prior.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PathologyPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

const SUFFICIENCY_TONE: Record<Sufficiency, string> = {
  sufficient: "bg-signal/15 text-signal border-signal/30",
  provisional: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  insufficient: "bg-muted text-muted-foreground border-border",
};

function fmt(v: number | null | undefined, dp = 2, unit = ""): string {
  return v == null ? "—" : `${v.toFixed(dp)}${unit}`;
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function SufficiencyBadge({ value }: { value: Sufficiency }) {
  return (
    <Badge variant="outline" className={SUFFICIENCY_TONE[value]}>
      {value}
    </Badge>
  );
}

function ScoreRow({ score }: { score: ScoreDiscrimination }) {
  const meta = SCORE_META.find((m) => m.key === score.score);
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{score.scoreLabel}</p>
          <p className="text-xs text-muted-foreground">{meta?.note}</p>
        </div>
        <SufficiencyBadge value={score.sufficiency} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">AUC</dt>
          <dd className="font-mono">
            {fmt(score.auc, 3)}
            {score.aucCi ? (
              <span className="ml-1 text-muted-foreground">
                ({score.aucCi.low.toFixed(2)}–{score.aucCi.high.toFixed(2)})
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sens / spec</dt>
          <dd className="font-mono">
            {score.operating
              ? `${pct(score.operating.sensitivity)} / ${pct(score.operating.specificity)}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Threshold</dt>
          <dd className="font-mono">
            {score.operating
              ? `${score.direction === "higher" ? "≥" : "≤"} ${score.operating.threshold.toFixed(meta?.dp ?? 2)}${meta?.unit ?? ""}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Class means</dt>
          <dd className="font-mono">
            {fmt(score.meanPositive, meta?.dp ?? 2)} vs {fmt(score.meanNegative, meta?.dp ?? 2)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{score.verdict}</p>
    </div>
  );
}

function PriorPanel({ axis }: { axis: LabelAxis }) {
  const lead = axis.scores.find((s) => s.score === axis.leadScore) ?? axis.scores[0];
  const defaultPrior = Math.round((axis.casePrevalence ?? 0.05) * 100);
  const [prior, setPrior] = useState(Math.min(Math.max(defaultPrior, 1), 90));
  const posterior = useMemo(() => {
    if (!lead?.operating) return null;
    return posteriorAtPrior(prior / 100, lead.operating.sensitivity, lead.operating.specificity);
  }, [lead, prior]);

  if (!lead?.operating) {
    return (
      <p className="text-xs text-muted-foreground">
        No operating point yet, so predictive value cannot be quoted at any prior.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Predictive value of {lead.scoreLabel} at a stated prior
        </p>
        <span className="font-mono text-xs text-muted-foreground">prior {prior}%</span>
      </div>
      <Slider
        value={[prior]}
        min={1}
        max={90}
        step={1}
        onValueChange={(v) => setPrior(v[0] ?? prior)}
        aria-label="Pre-test probability"
        className="max-w-md"
      />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">PPV</dt>
          <dd className="font-mono">{pct(posterior?.ppv)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">NPV</dt>
          <dd className="font-mono">{pct(posterior?.npv)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">LR+</dt>
          <dd className="font-mono">{fmt(posterior?.lrPositive ?? null, 2)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">LR−</dt>
          <dd className="font-mono">{fmt(posterior?.lrNegative ?? null, 2)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Sample prevalence was {pct(axis.samplePrevalence)} of epochs and {pct(axis.casePrevalence)}{" "}
        of cases. Move the slider to your own population: at a low prior a positive result is
        usually still a false alarm, however good the AUC looks.
      </p>
    </div>
  );
}

function AxisCard({
  axis,
  suppressionAxis,
}: {
  axis: LabelAxis;
  suppressionAxis?: LabelAxis | null;
}) {

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">{axis.label}</CardTitle>
            <CardDescription>{axis.description}</CardDescription>
          </div>
          <SufficiencyBadge value={axis.sufficiency} />
        </div>
        <div className="flex flex-wrap gap-2 pt-2 text-xs text-muted-foreground">
          <span>
            {axis.positives} {axis.positiveLabel} / {axis.n - axis.positives} {axis.negativeLabel}
          </span>
          <span>· {axis.cases} cases</span>
          <span>· labels: {axis.labelSources.join(", ") || "—"}</span>
          <span>· lineages: {axis.lineages.join(", ")}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{axis.verdict}</p>

        {axis.benchmark ? (
          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">COEBIS vs published indices</p>
              <SufficiencyBadge value={axis.benchmark.sufficiency} />
            </div>
            <p className="text-xs text-muted-foreground">
              Every index recomputed from the same {axis.benchmark.n} epochs across{" "}
              {axis.benchmark.cases} cases, so none is graded on an easier slice. The proprietary
              BIS composite is not reproducible here (it needs the bispectrum of the raw trace);
              these are its published components and the entropy monitor's own algorithm.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[360px] text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-3 font-normal">Index</th>
                    <th className="py-1 pr-3 font-normal">AUC (published direction)</th>
                    <th className="py-1 pr-3 font-normal">Best orientation</th>
                    <th className="py-1 font-normal">vs COEBIS</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-border/40 font-medium">
                    <td className="py-1 pr-3">COEBIS</td>
                    <td className="py-1 pr-3 font-mono">{fmt(axis.benchmark.coebisAuc, 3)}</td>
                    <td className="py-1 pr-3 font-mono">{fmt(axis.benchmark.coebisAuc, 3)}</td>
                    <td className="py-1 text-muted-foreground">—</td>
                  </tr>
                  <tr className="border-t border-border/40 font-medium">
                    <td className="py-1 pr-3">
                      COEBIS, drug-corrected
                      <span className="ml-1 font-normal text-muted-foreground">
                        {axis.benchmark.correctedEpochs
                          ? `(${axis.benchmark.correctedEpochs} epochs moved, mean ${fmt(
                              axis.benchmark.meanCorrection,
                              1,
                            )} pts)`
                          : "(no recorded agent moved the index here)"}
                      </span>
                    </td>
                    <td className="py-1 pr-3 font-mono">{fmt(axis.benchmark.correctedAuc, 3)}</td>
                    <td className="py-1 pr-3 font-mono">{fmt(axis.benchmark.correctedAuc, 3)}</td>
                    <td className="py-1 font-mono">
                      {axis.benchmark.correctionDelta == null
                        ? "—"
                        : `${axis.benchmark.correctionDelta >= 0 ? "+" : ""}${axis.benchmark.correctionDelta.toFixed(3)}`}
                    </td>
                  </tr>
                  {axis.benchmark.comparators.map((c) => (
                    <tr key={c.score} className="border-t border-border/40">
                      <td className="py-1 pr-3">
                        {c.label}
                        {c.inverted ? (
                          <span className="ml-1 text-muted-foreground">(runs backwards here)</span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-3 font-mono">{fmt(c.auc, 3)}</td>
                      <td className="py-1 pr-3 font-mono">{fmt(c.orientedAuc, 3)}</td>
                      <td className="py-1 font-mono">
                        {c.orientedAuc == null || axis.benchmark!.coebisAuc == null
                          ? "—"
                          : `${axis.benchmark!.coebisAuc - c.orientedAuc >= 0 ? "+" : ""}${(
                              axis.benchmark!.coebisAuc - c.orientedAuc
                            ).toFixed(3)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>

              </table>
            </div>
            <p className="mt-2 text-xs">{axis.benchmark.verdict}</p>

            <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">Suppression on these same epochs</p>
                <SufficiencyBadge value={axis.benchmark.suppressionOnSubset.sufficiency} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Recorded suppression labels</dt>
                  <dd className="font-mono">
                    {axis.benchmark.suppressionOnSubset.labelled}
                    {axis.benchmark.suppressionOnSubset.labelled ? (
                      <span className="ml-1 text-muted-foreground">
                        ({axis.benchmark.suppressionOnSubset.suppressed} suppressed /{" "}
                        {axis.benchmark.suppressionOnSubset.clear} clear)
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">App suppression AUC</dt>
                  <dd className="font-mono">
                    {fmt(axis.benchmark.suppressionOnSubset.appAuc, 3)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">COEBIS vs suppression</dt>
                  <dd className="font-mono">
                    {fmt(axis.benchmark.suppressionOnSubset.coebisAuc, 3)} /{" "}
                    {fmt(axis.benchmark.suppressionOnSubset.correctedAuc, 3)} corrected
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">App-measured suppression</dt>
                  <dd className="font-mono">
                    {fmt(axis.benchmark.suppressionOnSubset.meanAppSuppression, 1, "%")} mean,{" "}
                    {axis.benchmark.suppressionOnSubset.appFlagged} epochs &ge;1%
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                {axis.benchmark.suppressionOnSubset.verdict}
              </p>
              {suppressionAxis && suppressionAxis.key !== axis.key ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Graded alongside: the recorded-suppression axis runs on {suppressionAxis.n}{" "}
                  bedside-monitor epochs across {suppressionAxis.cases} cases (
                  {suppressionAxis.positives} suppressed), lead score{" "}
                  {suppressionAxis.scores.find((s) => s.score === suppressionAxis.leadScore)
                    ?.scoreLabel ?? "—"}{" "}
                  at AUC{" "}
                  {fmt(
                    suppressionAxis.scores.find((s) => s.score === suppressionAxis.leadScore)?.auc ??
                      null,
                    3,
                  )}
                  . Different recordings, so the two columns are not interchangeable.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}


        <div className="grid gap-3 sm:grid-cols-2">
          {axis.scores.map((s) => (
            <ScoreRow key={s.score} score={s} />
          ))}
        </div>


        <div className="rounded-lg border border-border/60 p-3">
          <p className="text-sm font-medium">Suppression as a confounder</p>
          <p className="text-xs text-muted-foreground">
            Mean suppression was {fmt(axis.suppressionPositive, 1, "%")} in {axis.positiveLabel}{" "}
            epochs and {fmt(axis.suppressionNegative, 1, "%")} in {axis.negativeLabel} epochs. A
            large gap means the separation below may be sedation depth, not pathology.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-normal">Band</th>
                  <th className="py-1 pr-3 font-normal">Epochs</th>
                  <th className="py-1 pr-3 font-normal">{axis.positiveLabel}</th>
                  <th className="py-1 pr-3 font-normal">Cases</th>
                  <th className="py-1 pr-3 font-normal">AUC</th>
                  <th className="py-1 font-normal">Data</th>
                </tr>
              </thead>
              <tbody>
                {axis.suppression.map((s) => (
                  <tr key={s.key} className="border-t border-border/40">
                    <td className="py-1 pr-3">{s.label}</td>
                    <td className="py-1 pr-3 font-mono">{s.n}</td>
                    <td className="py-1 pr-3 font-mono">{s.positives}</td>
                    <td className="py-1 pr-3 font-mono">{s.cases}</td>
                    <td className="py-1 pr-3 font-mono">{fmt(s.auc, 3)}</td>
                    <td className="py-1">
                      <SufficiencyBadge value={s.sufficiency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-border/60 p-3">
          <PriorPanel axis={axis} />
        </div>
      </CardContent>
    </Card>
  );
}

function PathologyPage() {
  const fetchLabels = useServerFn(getPathologyLabels);
  const { data, isLoading, error } = useQuery({
    queryKey: ["pathology-labels"],
    queryFn: () => fetchLabels({ data: {} }),
    staleTime: 60_000,
  });

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border/60 px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
              <Link to="/">
                <ArrowLeft className="size-4" /> Monitor
              </Link>
            </Button>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Brain className="size-4 text-signal" /> Pathology validation
            </span>
          </div>
          <AppNav showBrand={false} compact />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <section className="space-y-2">
          <h1 className="text-xl font-semibold">
            COEBIS and detector scores against recorded pathology
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Every label here came from outside the analysis path — a dataset&apos;s own annotation
            or a clinician&apos;s marked event. The app&apos;s seizure detections are never used as
            ground truth, because grading a detector against itself proves nothing. Suppression is
            reported as a confounder and predictive value only at a prior you set.
          </p>
        </section>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Collecting labelled epochs…
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-critical">
            {(error as Error).message}
          </p>
        ) : null}

        {data ? (
          <>
            {data.notes.length ? (
              <Card className="border-amber-500/30 bg-amber-500/5">
                <CardHeader>
                  <CardTitle className="text-base">What this data cannot show yet</CardTitle>
                  <CardDescription>
                    Read these before quoting any number below.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {data.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Labelled data inventory</CardTitle>
                <CardDescription>
                  {data.labelledEpochs.toLocaleString()} labelled of{" "}
                  {data.totalEpochs.toLocaleString()} epochs scanned.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-normal">Lineage</th>
                      <th className="py-1 pr-3 font-normal">Epochs</th>
                      <th className="py-1 pr-3 font-normal">Cases</th>
                      <th className="py-1 pr-3 font-normal">Seizure-labelled</th>
                      <th className="py-1 pr-3 font-normal">Ictal</th>
                      <th className="py-1 pr-3 font-normal">CNS-labelled</th>
                      <th className="py-1 pr-3 font-normal">Suppression-labelled</th>
                      <th className="py-1 pr-3 font-normal">Suppressed</th>
                      <th className="py-1 pr-3 font-normal">State-labelled</th>
                      <th className="py-1 pr-3 font-normal">Label source</th>
                      <th className="py-1 font-normal">Scores stored</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lineages.map((l) => (
                      <tr key={l.lineage} className="border-t border-border/40">
                        <td className="py-1 pr-3 font-mono">{l.lineage}</td>
                        <td className="py-1 pr-3 font-mono">{l.epochs}</td>
                        <td className="py-1 pr-3 font-mono">{l.cases}</td>
                        <td className="py-1 pr-3 font-mono">{l.seizureLabelled}</td>
                        <td className="py-1 pr-3 font-mono">{l.ictal}</td>
                        <td className="py-1 pr-3 font-mono">{l.cnsLabelled}</td>
                        <td className="py-1 pr-3 font-mono">{l.suppressionLabelled}</td>
                        <td className="py-1 pr-3 font-mono">{l.suppressed}</td>
                        <td className="py-1 pr-3 font-mono">{l.stateLabelled}</td>
                        <td className="py-1 pr-3">{l.labelSources.join(", ")}</td>
                        <td className="py-1">
                          {l.scoresPresent
                            .map((k) => SCORE_META.find((m) => m.key === k)?.label ?? k)
                            .join(", ") || "none"}
                        </td>
                      </tr>
                    ))}
                    {!data.lineages.length ? (
                      <tr>
                        <td colSpan={11} className="py-3 text-muted-foreground">
                          No independently labelled epochs are stored yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {data.axes.map((axis) => (
              <AxisCard
                key={axis.key}
                axis={axis}
                suppressionAxis={
                  data.axes.find((a) => a.key === "recorded-suppression") ?? null
                }
              />
            ))}


            {!data.axes.length ? (
              <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                  Nothing can be graded yet: no label axis has both a pathological and a control
                  group. Import a dataset with annotated ictal intervals, or mark seizure activity
                  on a live case timeline and record CNS disease on the case, and this page will
                  populate. CNS categories currently recognised include{" "}
                  {["epilepsy", "acute_stroke", "hypoxic_brain_injury", "tbi"]
                    .map(cnsLabelText)
                    .join(", ")}
                  .
                </CardContent>
              </Card>
            ) : null}

            <p className="text-xs text-muted-foreground">
              Generated {new Date(data.generatedAt).toLocaleString()}.
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
