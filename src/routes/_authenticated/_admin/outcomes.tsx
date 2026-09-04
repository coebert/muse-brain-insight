import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, HeartPulse, Loader2 } from "lucide-react";
import { useState } from "react";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { OutcomeEntryPanel } from "@/components/monitor/OutcomeEntryPanel";
import { getOutcomeReport } from "@/lib/eeg/outcomes.functions";

export const Route = createFileRoute("/_authenticated/_admin/outcomes")({
  head: () => ({
    meta: [
      { title: "Case outcomes — CortexTrace" },
      {
        name: "description",
        content:
          "Record what happened after each anaesthetic and see how depth and suppression exposure differs between cases with and without delirium, difficult emergence or unplanned ICU admission.",
      },
      { property: "og:title", content: "Case outcomes — CortexTrace" },
      {
        property: "og:description",
        content: "Link EEG exposure during each case to postoperative recovery.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OutcomesPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No cases found.</div>,
});

function OutcomesPage() {
  const [openCase, setOpenCase] = useState<string | null>(null);
  const fetchReport = useServerFn(getOutcomeReport);
  const { data, isLoading, error } = useQuery({
    queryKey: ["outcome-report"],
    queryFn: () => fetchReport(),
  });

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/cases">
            <ArrowLeft className="size-4" /> Cases
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <HeartPulse className="size-5 text-signal" /> Case outcomes
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        The point of measuring depth is what happens to the patient afterwards. Record recovery for
        each case here and the app will compare depth and suppression exposure between the cases
        that had a complication and those that did not. With small numbers these are
        hypothesis-generating signals, not causal findings.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading cases…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load outcomes."}
        </p>
      ) : !data ? null : (
        <div className="space-y-4">
          <p className="panel p-3 text-sm">
            {data.recorded} of {data.cases.length} case{data.cases.length === 1 ? "" : "s"} have an
            outcome recorded.
          </p>

          {data.signals.length > 0 && (
            <section className="panel p-3">
              <h2 className="mb-2 text-sm font-semibold">Signals so far</h2>
              <ul className="space-y-2 text-sm">
                {data.signals.map((s) => (
                  <li key={`${s.outcome}-${s.exposure}`} className="border-t border-border/60 pt-2 first:border-0 first:pt-0">
                    <p className="font-medium">
                      {s.outcome} · {s.exposure}
                    </p>
                    <p className="text-xs text-muted-foreground">{s.note}</p>
                    {!s.meaningful && (
                      <p className="text-xs text-warning">Too few cases in one arm to read into yet.</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            {data.cases.map((c) => (
              <div key={c.sessionId} className="panel p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{c.caseCode}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.durationMinutes} min · mean index {c.meanDepth ?? "—"} · {c.minutesDeep} min
                    below 40 · {c.minutesSuppressed} min suppressed
                    {c.ageBand ? ` · ${c.ageBand}` : ""}
                  </span>
                  <Button
                    size="sm"
                    variant={c.outcome ? "outline" : "default"}
                    className="ml-auto min-h-11 sm:min-h-9"
                    onClick={() => setOpenCase(openCase === c.sessionId ? null : c.sessionId)}
                  >
                    {c.outcome ? "Edit outcome" : "Record outcome"}
                  </Button>
                </div>
                {openCase === c.sessionId && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <OutcomeEntryPanel outcomeCase={c} onSaved={() => setOpenCase(null)} />
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
