import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, FlaskConical, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getDrugLibrary } from "@/lib/eeg/drug-library.functions";
import { orderedLibrary, type DrugLibraryEntry } from "@/lib/eeg/drug-library";

export const Route = createFileRoute("/_authenticated/_admin/drugs")({
  head: () => ({
    meta: [
      { title: "Anaesthetic drug library — CortexTrace" },
      {
        name: "description",
        content:
          "Every anaesthetic agent COEBIS knows: its frontal EEG signature, the bounded correction it earns, the case sources it appears in and how many cases cover it.",
      },
      { property: "og:title", content: "Anaesthetic drug library — CortexTrace" },
      {
        property: "og:description",
        content:
          "Per-agent EEG signatures, correction limits, source lineages and independent case coverage across every ingested corpus.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DrugLibraryPage,
});

const ROLE_LABEL: Record<DrugLibraryEntry["role"], string> = {
  corrected: "corrected",
  reference: "reference agent",
  neutral: "no correction",
};

const ROLE_CLASS: Record<DrugLibraryEntry["role"], string> = {
  corrected: "bg-signal/15 text-signal",
  reference: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-muted-foreground",
};

function correctionText(entry: DrugLibraryEntry): string {
  if (entry.role !== "corrected") return "none";
  if (entry.direction === -1) {
    return `down to ${entry.cap} pts, never below ${entry.floor ?? 0}`;
  }
  return `up to ${entry.cap} pts, never above ${entry.ceiling ?? 100}`;
}

function DrugLibraryPage() {
  const fetchLibrary = useServerFn(getDrugLibrary);
  const [roleFilter, setRoleFilter] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["drug-library"],
    queryFn: () => fetchLibrary({ data: {} }),
    staleTime: 5 * 60_000,
  });

  const entries = useMemo(() => (data ? orderedLibrary(data.entries) : []), [data]);
  const rows = useMemo(
    () => (roleFilter === "all" ? entries : entries.filter((e) => e.role === roleFilter)),
    [entries, roleFilter],
  );
  const coveredCount = entries.filter((e) => e.covered).length;

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border/60 bg-card/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4">
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <Link to="/ketamine">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Ketamine
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-signal" />
            <div>
              <h1 className="text-lg font-semibold">Anaesthetic drug library</h1>
              <p className="text-xs text-muted-foreground">
                What each agent does to the frontal EEG, and how much of it this corpus has seen
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Scanning declared regimens across every
            stored case…
          </div>
        ) : error ? (
          <p className="text-sm text-alert">{(error as Error).message}</p>
        ) : !data ? null : (
          <>
            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger className="min-h-11 w-full sm:w-[260px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents · {entries.length}</SelectItem>
                    <SelectItem value="corrected">
                      Corrected · {entries.filter((e) => e.role === "corrected").length}
                    </SelectItem>
                    <SelectItem value="reference">
                      Reference agents · {entries.filter((e) => e.role === "reference").length}
                    </SelectItem>
                    <SelectItem value="neutral">
                      No correction · {entries.filter((e) => e.role === "neutral").length}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {coveredCount} of {entries.length} agents recorded in at least one case ·{" "}
                  {data.totalCases} cases across {data.totalLineages} sources ·{" "}
                  {data.scanned.toLocaleString()} rows scanned
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Agents</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Coverage counts cases whose record names the agent — a regimen entry, an
                effect-site concentration or a clinician marker. An agent with no recorded case
                still corrects when it is declared; it simply has not been exercised here.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="p-2 font-medium">Agent</th>
                      <th className="p-2 font-medium">Handling</th>
                      <th className="p-2 font-medium">Correction</th>
                      <th className="p-2 font-medium">Cases</th>
                      <th className="p-2 font-medium">Sources and coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.key} className="border-t border-border/40 align-top">
                        <td className="p-2">
                          <div className="font-medium">{e.label}</div>
                          <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">
                            {e.rationale}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Recognised as: {e.terms.join(", ")}
                          </p>
                        </td>
                        <td className="p-2">
                          <span className={cn("rounded px-1.5 py-0.5 text-[11px]", ROLE_CLASS[e.role])}>
                            {ROLE_LABEL[e.role]}
                          </span>
                        </td>
                        <td className="p-2 text-[11px] text-muted-foreground">
                          {correctionText(e)}
                        </td>
                        <td className="p-2">
                          <span className={cn("metric-value", e.covered ? "" : "text-muted-foreground")}>
                            {e.totalCases}
                          </span>
                          {e.patternOnlyCases > 0 && (
                            <p className="mt-1 text-[11px] text-caution">
                              +{e.patternOnlyCases} pattern only
                            </p>
                          )}
                        </td>
                        <td className="p-2">
                          {e.lineages.length === 0 ? (
                            <span className="text-[11px] text-muted-foreground">
                              Not recorded in any case held here
                            </span>
                          ) : (
                            <ul className="space-y-1">
                              {e.lineages.map((l) => (
                                <li key={l.lineage} className="flex flex-wrap items-baseline gap-2">
                                  <span className="text-muted-foreground">{l.lineage}</span>
                                  <span className="metric-value">{l.cases} cases</span>
                                  <span className="text-[11px] text-muted-foreground">
                                    {l.epochs.toLocaleString()} epochs
                                    {e.role !== "corrected" || l.meanScore == null
                                      ? ""
                                      : ` · mean pattern ${l.meanScore.toFixed(2)}`}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {data.notes.length > 0 && (
              <section className="rounded-lg border border-border/60 bg-card/40 p-4">
                <h2 className="text-sm font-semibold">What this coverage does and does not show</h2>
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
