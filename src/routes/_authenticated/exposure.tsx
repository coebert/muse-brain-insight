import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Loader2, Syringe } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getDrugExposure } from "@/lib/eeg/drug-exposure.functions";
import type { DrugCohort, ExposureCase } from "@/lib/eeg/drug-exposure";
import type { Grade } from "@/lib/eeg/ketamine-cases";

export const Route = createFileRoute("/_authenticated/exposure")({
  head: () => ({
    meta: [
      { title: "Drug exposure by case — CortexTrace" },
      {
        name: "description",
        content:
          "Which anaesthetic agents each case received, how COEBIS and suppression read under them, and which cohorts have enough labelled cases to be compared.",
      },
      { property: "og:title", content: "Drug exposure by case — CortexTrace" },
      {
        property: "og:description",
        content:
          "Per-case drug exposure with COEBIS depth-state and suppression grades, pooled into per-agent cohorts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DrugExposurePage,
});

const GRADE_CLASS: Record<Grade, string> = {
  agrees: "bg-signal/15 text-signal",
  separates: "bg-signal/15 text-signal",
  disagrees: "bg-alert/15 text-alert",
  overlaps: "bg-caution/15 text-caution",
  insufficient: "bg-muted text-muted-foreground",
};

function GradeChip({ grade }: { grade: Grade }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[11px]", GRADE_CLASS[grade])}>
      {grade === "insufficient" ? "not gradeable" : grade}
    </span>
  );
}

function pct(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function points(value: number | null, digits = 1): string {
  return value == null ? "—" : value.toFixed(digits);
}

function CohortCard({ cohort }: { cohort: DrugCohort }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        cohort.comparable ? "border-border/60 bg-card/40" : "border-border/40 bg-card/20",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{cohort.label}</h3>
        <span className="text-[11px] text-muted-foreground">
          {cohort.comparable ? "comparable" : "too few cases to compare"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {cohort.cases} cases · {cohort.epochs.toLocaleString()} epochs
        {cohort.role === "none" ? "" : ` · ${cohort.role}`}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        <div>
          <dt className="text-muted-foreground">Mean index</dt>
          <dd className="metric-value">{points(cohort.meanIndex)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Mean suppression</dt>
          <dd className="metric-value">
            {cohort.meanSuppressionPct == null ? "—" : `${cohort.meanSuppressionPct.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Awake − anaesthetised</dt>
          <dd className="metric-value">
            {cohort.separation == null ? "—" : `${cohort.separation.toFixed(1)} pts`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Mean correction</dt>
          <dd className="metric-value">{points(cohort.meanCorrection)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cases separating</dt>
          <dd className="metric-value">
            {cohort.separatingCases}/{cohort.gradedCases || 0}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Suppression agrees</dt>
          <dd className="metric-value">
            {cohort.agreeingCases}/{cohort.cases}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Labelled epochs: {cohort.anaesthetisedEpochs.toLocaleString()} anaesthetised ·{" "}
        {cohort.awakeEpochs.toLocaleString()} awake
      </p>
    </div>
  );
}

function CaseRow({ row }: { row: ExposureCase }) {
  return (
    <tr className="border-t border-border/40 align-top">
      <td className="p-2">
        <div className="font-medium">{row.caseRef}</div>
        <p className="text-[11px] text-muted-foreground">{row.lineage}</p>
        <p className="text-[11px] text-muted-foreground">{row.epochs.toLocaleString()} epochs</p>
      </td>
      <td className="p-2">
        {row.drugLabels.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No agent recorded</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.drugLabels.map((d) => (
              <span key={d} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                {d}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="p-2">
        <span className="metric-value">{points(row.meanIndex)}</span>
        <p className="text-[11px] text-muted-foreground">
          low {points(row.minIndex)} · {pct(row.anaestheticFraction)} anaesthetic
        </p>
      </td>
      <td className="p-2">
        <span className="metric-value">
          {row.meanSuppressionPct == null ? "—" : `${row.meanSuppressionPct.toFixed(1)}%`}
        </span>
        <p className="text-[11px] text-muted-foreground">
          {pct(row.suppressedFraction)} of epochs suppressed
        </p>
      </td>
      <td className="p-2">
        <GradeChip grade={row.state.grade} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {row.state.separation == null
            ? `${row.state.anaesthetised}/${row.state.awake} labelled epochs`
            : `${row.state.separation.toFixed(1)} pts apart`}
        </p>
      </td>
      <td className="p-2">
        <GradeChip grade={row.suppression.grade} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {row.suppression.concordance == null
            ? `${row.suppression.labelled} labelled epochs`
            : `${(row.suppression.concordance * 100).toFixed(0)}% concordant`}
        </p>
      </td>
      <td className="p-2 text-[11px] text-muted-foreground">
        {row.meanCorrection == null
          ? "none applied"
          : `${row.meanCorrection.toFixed(2)} pts over ${row.correctedEpochs.toLocaleString()} epochs`}
      </td>
    </tr>
  );
}

function DrugExposurePage() {
  const fetchExposure = useServerFn(getDrugExposure);
  const [drugFilter, setDrugFilter] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["drug-exposure"],
    queryFn: () => fetchExposure({ data: {} }),
    staleTime: 5 * 60_000,
  });

  const cases = useMemo(() => {
    if (!data) return [];
    if (drugFilter === "all") return data.cases;
    if (drugFilter === "none") return data.cases.filter((c) => c.drugs.length === 0);
    return data.cases.filter((c) => c.drugs.includes(drugFilter as never));
  }, [data, drugFilter]);

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border/60 bg-card/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4">
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <Link to="/drugs">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Drug library
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Syringe className="h-5 w-5 text-signal" />
            <div>
              <h1 className="text-lg font-semibold">Drug exposure by case</h1>
              <p className="text-xs text-muted-foreground">
                What each patient received, and how the index and suppression read under it
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading exposure and labels for every stored
            case…
          </div>
        ) : error ? (
          <p className="text-sm text-alert">{(error as Error).message}</p>
        ) : !data ? null : (
          <>
            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={drugFilter} onValueChange={setDrugFilter}>
                  <SelectTrigger className="min-h-11 w-full sm:w-[280px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All cases · {data.totals.cases}</SelectItem>
                    {data.cohorts.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.label} · {c.cases}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {data.totals.exposedCases} of {data.totals.cases} cases name an agent ·{" "}
                  {data.totals.gradedCases} carry gradeable labels ·{" "}
                  {data.totals.comparableCohorts} comparable cohorts ·{" "}
                  {data.scanned.toLocaleString()} rows scanned
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Cohorts</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Each agent's cases pooled: how deep the index reads, how much suppression the
                recordings carry, and whether the index separated anaesthetised from awake where
                labels exist.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.cohorts.map((c) => (
                  <CohortCard key={c.key} cohort={c} />
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Cases</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {cases.length} shown. Exposure comes from the case record only — regimen, effect-site
                entry or clinician marker.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="p-2 font-medium">Case</th>
                      <th className="p-2 font-medium">Agents</th>
                      <th className="p-2 font-medium">COEBIS</th>
                      <th className="p-2 font-medium">Suppression</th>
                      <th className="p-2 font-medium">Depth-state grade</th>
                      <th className="p-2 font-medium">Suppression grade</th>
                      <th className="p-2 font-medium">Drug correction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((row) => (
                      <CaseRow key={`${row.lineage}/${row.caseRef}`} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {data.notes.length > 0 && (
              <section className="rounded-lg border border-border/60 bg-card/40 p-4">
                <h2 className="text-sm font-semibold">How to read this</h2>
                <ul className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
                  {data.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
