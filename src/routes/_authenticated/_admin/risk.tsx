import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Activity, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { MIN_ARM } from "@/lib/eeg/case-outcomes";
import { getOutcomeCohort } from "@/lib/eeg/case-outcomes.functions";
import { getOutcomeReport } from "@/lib/eeg/outcomes.functions";
import {
  predictOutcome,
  type DaysEstimate,
  type RateEstimate,
  type RiskInput,
} from "@/lib/eeg/outcome-risk";

export const Route = createFileRoute("/_authenticated/_admin/risk")({
  head: () => ({
    meta: [
      { title: "Outcome risk — CortexTrace" },
      {
        name: "description",
        content:
          "Take a bedside case's depth and suppression exposure and read what happened to the cohort recordings that look like it: intensive care, length of stay and in-hospital death, each with a confidence range.",
      },
      { property: "og:title", content: "Outcome risk — CortexTrace" },
      {
        property: "og:description",
        content:
          "Depth and suppression exposure placed against the outcome cohort, with confidence ranges on every rate.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RiskPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No cases found.</div>,
});

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const days = (v: number | null) => (v == null ? "—" : `${v} d`);

function RateCard({ rate }: { rate: RateEstimate }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <p className="text-xs text-muted-foreground">{rate.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{pct(rate.rate)}</p>
      <p className="text-xs text-muted-foreground">
        range {pct(rate.low)}–{pct(rate.high)} · {rate.events} of {rate.matched} similar recordings
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        whole cohort {pct(rate.cohortRate)}
      </p>
      {!rate.readable && (
        <p className="mt-2 text-xs text-warning">
          Fewer than {MIN_ARM} similar recordings with this outcome recorded — not readable yet.
        </p>
      )}
    </div>
  );
}

function DaysCard({ estimate }: { estimate: DaysEstimate }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <p className="text-xs text-muted-foreground">{estimate.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{days(estimate.median)}</p>
      <p className="text-xs text-muted-foreground">
        middle 80% {days(estimate.low)}–{days(estimate.high)} · {estimate.matched} recordings
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        whole cohort {days(estimate.cohortMedian)}
      </p>
      {!estimate.readable && (
        <p className="mt-2 text-xs text-warning">
          Fewer than {MIN_ARM} similar recordings with a stay recorded — not readable yet.
        </p>
      )}
    </div>
  );
}

function RiskPage() {
  const fetchCohort = useServerFn(getOutcomeCohort);
  const fetchCases = useServerFn(getOutcomeReport);
  const [selected, setSelected] = useState<string | null>(null);

  const cohortQuery = useQuery({ queryKey: ["outcome-cohort"], queryFn: () => fetchCohort() });
  const caseQuery = useQuery({ queryKey: ["outcome-report"], queryFn: () => fetchCases() });

  const inputs = useMemo<RiskInput[]>(
    () =>
      (caseQuery.data?.cases ?? [])
        .filter((c) => c.durationMinutes > 0)
        .map((c) => ({
          caseRef: c.sessionId,
          label: c.caseCode,
          minutes: c.durationMinutes,
          meanIndex: c.meanDepth,
          minutesBelow40: c.minutesDeep,
          minutesSuppressed: c.minutesSuppressed,
        })),
    [caseQuery.data],
  );

  const active = inputs.find((i) => i.caseRef === selected) ?? inputs[0] ?? null;
  const prediction = useMemo(
    () => (active && cohortQuery.data ? predictOutcome(active, cohortQuery.data.cases) : null),
    [active, cohortQuery.data],
  );

  const loading = cohortQuery.isLoading || caseQuery.isLoading;

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/casebook">
            <ArrowLeft className="mr-1 h-4 w-4" /> Cases
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="h-5 w-5 text-signal" /> Outcome risk
        </h1>
      </header>
      <AppNav />

      <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
        Pick a bedside case. Its depth and suppression exposure is matched to the cohort recordings
        with the most similar exposure, and what happened to those patients is shown below with a
        range around each figure. This is a description of similar recordings, not a prediction for
        this patient: the cohort takes no account of how sick the patient was or how big the
        operation.
      </p>

      {loading && (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading cases and cohort…
        </p>
      )}

      {!loading && !inputs.length && (
        <p className="mt-6 text-sm text-muted-foreground">
          No recorded cases yet — file a case from the bedside screen first.
        </p>
      )}

      {!loading && inputs.length > 0 && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[260px_1fr]">
          <nav className="rounded-lg border border-border/60 bg-card p-2">
            <p className="px-2 pb-2 text-xs text-muted-foreground">{inputs.length} cases</p>
            <ul className="max-h-[28rem] space-y-1 overflow-y-auto">
              {inputs.map((i) => (
                <li key={i.caseRef}>
                  <button
                    type="button"
                    onClick={() => setSelected(i.caseRef)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                      active?.caseRef === i.caseRef ? "bg-signal/15 text-signal" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="block truncate">{i.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {Math.round(i.minutes)} min · {i.minutesBelow40} min below 40
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <section className="space-y-4">
            {!prediction && (
              <p className="text-sm text-muted-foreground">
                The cohort holds no recordings with a confirmed outcome yet, so nothing can be
                matched. Import outcomes on the{" "}
                <Link to="/cohort" className="underline">
                  outcome cohort
                </Link>{" "}
                page first.
              </p>
            )}

            {prediction && (
              <>
                <div className="rounded-lg border border-border/60 bg-card p-3">
                  <h2 className="text-sm font-medium">{prediction.input.label}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{prediction.headline}</p>
                  <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted-foreground">Length</dt>
                      <dd className="tabular-nums">{Math.round(prediction.input.minutes)} min</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Average depth</dt>
                      <dd className="tabular-nums">{prediction.input.meanIndex ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Below 40</dt>
                      <dd className="tabular-nums">
                        {prediction.input.minutesBelow40} min
                        {prediction.percentileBelow40 != null && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({prediction.percentileBelow40}th)
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Suppressed</dt>
                      <dd className="tabular-nums">
                        {prediction.input.minutesSuppressed} min
                        {prediction.percentileSuppressed != null && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({prediction.percentileSuppressed}th)
                          </span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Matched to {prediction.neighbours} of {prediction.cohortCases} cohort recordings
                    with a confirmed outcome.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {prediction.rates.map((r) => (
                    <RateCard key={r.key} rate={r} />
                  ))}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {prediction.days.map((d) => (
                    <DaysCard key={d.key} estimate={d} />
                  ))}
                </div>

                {!prediction.readable && (
                  <p className="text-xs text-warning">
                    The matched neighbourhood is too small for any of these figures to be read as a
                    finding. They are shown so the size of the gap is visible, not to be acted on.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
