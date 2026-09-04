import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Library, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getCovariateDiscovery } from "@/lib/eeg/covariate-discovery.functions";
import type { CandidateCoebisTerm } from "@/lib/eeg/covariate-discovery";

export const Route = createFileRoute("/_authenticated/terms")({
  head: () => ({
    meta: [
      { title: "COEBIS term library — CortexTrace" },
      {
        name: "description",
        content:
          "Every candidate COEBIS covariate term found by discovery, with the lineages it came from and how many independent cases it covers.",
      },
      { property: "og:title", content: "COEBIS term library — CortexTrace" },
      {
        property: "og:description",
        content:
          "Candidate covariate terms across all ingested lineages: shrunken index-point offsets, source lineages and independent case coverage.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TermLibraryPage,
});

interface TermOccurrence extends CandidateCoebisTerm {}

interface LibraryEntry {
  key: string;
  group: string;
  groupLabel: string;
  level: string;
  levelLabel: string;
  /** Lineages where this covariate level produced a candidate or watch term. */
  occurrences: TermOccurrence[];
  /** Distinct independent cases across those lineages (lineage case refs never overlap). */
  totalCases: number;
  status: "candidate" | "watch";
}

function signed(v: number, dp = 1) {
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
}

function TermLibraryPage() {
  const fetchDiscovery = useServerFn(getCovariateDiscovery);
  const [groupFilter, setGroupFilter] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["covariate-discovery"],
    queryFn: () => fetchDiscovery({ data: {} }),
    staleTime: 5 * 60_000,
  });

  const library = useMemo<LibraryEntry[]>(() => {
    if (!data) return [];
    const byTerm = new Map<string, LibraryEntry>();
    for (const l of data.lineages) {
      for (const c of l.candidates) {
        const key = `${c.group}:${c.level}`;
        const entry =
          byTerm.get(key) ??
          ({
            key,
            group: c.group,
            groupLabel: c.groupLabel,
            level: c.level,
            levelLabel: c.levelLabel,
            occurrences: [],
            totalCases: 0,
            status: "watch",
          } satisfies LibraryEntry);
        entry.occurrences.push(c);
        entry.totalCases += c.cases;
        if (c.status === "candidate") entry.status = "candidate";
        byTerm.set(key, entry);
      }
    }
    return [...byTerm.values()].sort(
      (a, b) =>
        b.occurrences.length - a.occurrences.length ||
        b.totalCases - a.totalCases ||
        Math.abs(b.occurrences[0]!.dy) - Math.abs(a.occurrences[0]!.dy),
    );
  }, [data]);

  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of library) seen.set(e.group, e.groupLabel);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [library]);

  const rows = useMemo(
    () => (groupFilter === "all" ? library : library.filter((e) => e.group === groupFilter)),
    [library, groupFilter],
  );

  const candidateCount = library.filter((e) => e.status === "candidate").length;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-card/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4">
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <Link to="/discovery">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Discovery
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Library className="h-5 w-5 text-signal" />
            <div>
              <h1 className="text-lg font-semibold">COEBIS term library</h1>
              <p className="text-xs text-muted-foreground">
                Candidate covariate terms pooled across every ingested lineage
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Scanning stored spectral epochs…
          </div>
        ) : error ? (
          <p className="text-sm text-alert">{(error as Error).message}</p>
        ) : library.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No candidate terms yet. Discovery only seeds a term where a covariate level shifts the
            EEG features far enough, on at least two independent cases.
          </p>
        ) : (
          <>
            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={groupFilter} onValueChange={setGroupFilter}>
                  <SelectTrigger className="min-h-11 w-full sm:w-[260px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All covariates · {library.length} terms</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.key} value={g.key}>
                        {g.label} · {library.filter((e) => e.group === g.key).length}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {library.length} distinct terms · {candidateCount} at candidate strength · a term
                  found in several lineages is more trustworthy than one seen once
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Terms</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Offsets are shrunken seed values in index points, capped at ±6. Nothing here is in
                the depth model — a term is only promoted by the refit gate on paired reference
                readings.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="p-2 font-medium">Term</th>
                      <th className="p-2 font-medium">Covariate</th>
                      <th className="p-2 font-medium">Cases</th>
                      <th className="p-2 font-medium">State</th>
                      <th className="p-2 font-medium">Lineages and seed offsets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.key} className="border-t border-border/40 align-top">
                        <td className="p-2 font-medium">
                          {e.groupLabel}: {e.levelLabel}
                        </td>
                        <td className="p-2 text-muted-foreground">{e.groupLabel}</td>
                        <td className="p-2">{e.totalCases}</td>
                        <td className="p-2">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[11px]",
                              e.status === "candidate"
                                ? "bg-signal/15 text-signal"
                                : "bg-caution/15 text-caution",
                            )}
                          >
                            {e.status}
                          </span>
                        </td>
                        <td className="p-2">
                          <ul className="space-y-1">
                            {e.occurrences.map((o) => (
                              <li key={o.lineage} className="flex flex-wrap items-baseline gap-2">
                                <span className="text-muted-foreground">{o.lineage}</span>
                                <span
                                  className={cn(
                                    "metric-value",
                                    o.dy > 0 ? "text-signal" : "text-alert",
                                  )}
                                >
                                  {signed(o.dy)} pts
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {o.cases} cases · shrinkage ×{o.shrinkage.toFixed(2)}
                                  {o.status === "watch" ? " · watch" : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
