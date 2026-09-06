import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Database, Download, Loader2 } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { MIN_ARM, type CohortContrast } from "@/lib/eeg/case-outcomes";
import { getOutcomeCohort, importCohortOutcomes } from "@/lib/eeg/case-outcomes.functions";

export const Route = createFileRoute("/_authenticated/_admin/cohort")({
  head: () => ({
    meta: [
      { title: "Outcome cohort — CortexTrace" },
      {
        name: "description",
        content:
          "Recordings paired with confirmed hospital outcomes: in-hospital death, intensive care and length of stay, set beside how long each case spent deep or suppressed.",
      },
      { property: "og:title", content: "Outcome cohort — CortexTrace" },
      {
        property: "og:description",
        content: "Depth exposure per case beside what actually happened to the patient.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CohortPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No cohort found.</div>,
});

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const mins = (v: number | null) => (v == null ? "—" : `${v} min`);

function ContrastRow({ contrast }: { contrast: CohortContrast }) {
  return (
    <div className="border-t border-border/60 py-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-medium">{contrast.label}</h3>
        <span className="text-xs text-muted-foreground">
          {contrast.withN} yes · {contrast.withoutN} no
          {contrast.unknownN > 0 ? ` · ${contrast.unknownN} not recorded` : ""}
        </span>
      </div>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-md bg-muted/40 p-2">
          <dt className="text-xs text-muted-foreground">Time below 40</dt>
          <dd>
            {mins(contrast.withMinutesBelow40)} vs {mins(contrast.withoutMinutesBelow40)}
            <span className="ml-1 text-xs text-muted-foreground">
              ({pct(contrast.withFractionBelow40)} vs {pct(contrast.withoutFractionBelow40)} of the case)
            </span>
          </dd>
        </div>
        <div className="rounded-md bg-muted/40 p-2">
          <dt className="text-xs text-muted-foreground">Time suppressed</dt>
          <dd>
            {mins(contrast.withMinutesSuppressed)} vs {mins(contrast.withoutMinutesSuppressed)}
          </dd>
        </div>
      </dl>
      {contrast.underpowered && (
        <p className="mt-2 text-xs text-warning">
          Fewer than {MIN_ARM} cases on one side — this difference is not readable yet, whichever way
          it points.
        </p>
      )}
    </div>
  );
}

function CohortPage() {
  const queryClient = useQueryClient();
  const fetchCohort = useServerFn(getOutcomeCohort);
  const runImport = useServerFn(importCohortOutcomes);

  const { data, isLoading, error } = useQuery({
    queryKey: ["outcome-cohort"],
    queryFn: () => fetchCohort(),
  });

  const importMutation = useMutation({
    mutationFn: () => runImport(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["outcome-cohort"] }),
  });

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/admin">
            <ArrowLeft className="size-4" /> Admin
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Database className="size-5 text-signal" /> Outcome cohort
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        These are recordings where the hospital's own record of what happened is known: whether the
        patient died before discharge, whether they needed intensive care, and how long they stayed.
        Each is set beside how long that case spent below the usual surgical range and how long it
        spent suppressed. Outcomes come from the registry's clinical record only — never from the
        EEG, and never from a model.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => importMutation.mutate()}
          disabled={importMutation.isPending}
          className="min-h-11 sm:min-h-9"
        >
          {importMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Fetch outcomes for pooled cases
        </Button>
        {importMutation.isSuccess && (
          <span className="text-sm text-muted-foreground">
            {importMutation.data.matched} of {importMutation.data.casesInPool} cases matched ·{" "}
            {importMutation.data.withDeath} with a survival record · {importMutation.data.withIcu}{" "}
            with an intensive care record · {importMutation.data.withStay} with a length of stay
          </span>
        )}
        {importMutation.isError && (
          <span role="alert" className="text-sm text-critical">
            {importMutation.error instanceof Error
              ? importMutation.error.message
              : "The outcomes could not be fetched."}
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Building the cohort…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load the cohort."}
        </p>
      ) : !data ? null : (
        <div className="space-y-4">
          <p className="panel p-3 text-sm">
            {data.casesWithOutcome} of {data.cases.length} recording
            {data.cases.length === 1 ? "" : "s"} have a confirmed outcome attached.
          </p>

          <section className="panel p-3">
            <h2 className="mb-1 text-sm font-semibold">What depth exposure looks like by outcome</h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Averages across cases, not adjusted for how sick the patient was or how big the
              operation was. Sicker patients are anaesthetised differently, so a difference here is a
              question to investigate, not a cause.
            </p>
            {data.contrasts.map((c) => (
              <ContrastRow key={c.key} contrast={c} />
            ))}
          </section>

          <section className="panel overflow-x-auto p-3">
            <h2 className="mb-2 text-sm font-semibold">Every case in the cohort</h2>
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Case</th>
                  <th className="py-1 pr-3">Length</th>
                  <th className="py-1 pr-3">Mean index</th>
                  <th className="py-1 pr-3">Below 40</th>
                  <th className="py-1 pr-3">Suppressed</th>
                  <th className="py-1 pr-3">Died</th>
                  <th className="py-1 pr-3">ICU days</th>
                  <th className="py-1 pr-3">Stay</th>
                  <th className="py-1">Operation</th>
                </tr>
              </thead>
              <tbody>
                {data.cases.map((c) => (
                  <tr key={c.caseRef} className="border-t border-border/60">
                    <td className="py-1 pr-3 font-medium">{c.caseRef}</td>
                    <td className="py-1 pr-3">{c.exposure.minutes} min</td>
                    <td className="py-1 pr-3">{c.exposure.meanIndex}</td>
                    <td className="py-1 pr-3">
                      {c.exposure.minutesBelow40} min
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({Math.round(c.exposure.fractionBelow40 * 100)}%)
                      </span>
                    </td>
                    <td className="py-1 pr-3">{c.exposure.minutesSuppressed} min</td>
                    <td className="py-1 pr-3">
                      {c.outcome?.inHospitalDeath == null
                        ? "—"
                        : c.outcome.inHospitalDeath
                          ? "yes"
                          : "no"}
                    </td>
                    <td className="py-1 pr-3">{c.outcome?.icuDays ?? "—"}</td>
                    <td className="py-1 pr-3">
                      {c.outcome?.hospitalDays == null ? "—" : `${c.outcome.hospitalDays} d`}
                    </td>
                    <td className="py-1 text-xs text-muted-foreground">
                      {c.outcome?.optype ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </main>
  );
}
