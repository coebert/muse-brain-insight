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
import { getCovariateDiscovery } from "@/lib/eeg/covariate-discovery.functions";
import {
  DISCOVERY_FEATURES,
  type DiscoveryAssociation,
  type FeatureKey,
} from "@/lib/eeg/covariate-discovery";

export const Route = createFileRoute("/_authenticated/discovery")({
  head: () => ({
    meta: [
      { title: "Covariate–feature discovery — CortexTrace" },
      {
        name: "description",
        content:
          "Per-lineage analysis of how age, sex and anaesthetic agent relate to EEG band power, spectral edge and suppression, and the COEBIS terms they suggest.",
      },
      { property: "og:title", content: "Covariate–feature discovery — CortexTrace" },
      {
        property: "og:description",
        content:
          "Age, sex and agent versus EEG power, SEF95 and suppression for every ingested lineage, with candidate COEBIS covariate terms.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DiscoveryPage,
});

const SUFFICIENCY_TONE: Record<DiscoveryAssociation["sufficiency"], string> = {
  sufficient: "bg-signal/15 text-signal",
  provisional: "bg-caution/15 text-caution",
  insufficient: "bg-muted text-muted-foreground",
};

function fmt(v: number | null | undefined, dp = 2) {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}
function signed(v: number, dp = 2) {
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
}

function cellTone(effect: number) {
  const a = Math.abs(effect);
  if (a < 0.2) return "bg-muted/30 text-muted-foreground";
  if (effect > 0) return a > 0.8 ? "bg-signal/30 text-signal" : "bg-signal/15 text-signal";
  return a > 0.8 ? "bg-alert/30 text-alert" : "bg-alert/15 text-alert";
}

function DiscoveryPage() {
  const fetchDiscovery = useServerFn(getCovariateDiscovery);
  const [lineage, setLineage] = useState<string>("");
  const [onlySignificant, setOnlySignificant] = useState(true);

  const { data, isLoading, error } = useQuery({
    queryKey: ["covariate-discovery"],
    queryFn: () => fetchDiscovery({ data: {} }),
    staleTime: 5 * 60_000,
  });

  const selected = useMemo(() => {
    if (!data?.lineages.length) return null;
    return data.lineages.find((l) => l.lineage === lineage) ?? data.lineages[0]!;
  }, [data, lineage]);

  const groups = useMemo(() => {
    if (!selected) return [] as { key: string; label: string }[];
    const seen = new Map<string, string>();
    for (const a of selected.associations) seen.set(a.group, a.groupLabel);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [selected]);

  const matrix = useMemo(() => {
    if (!selected) return new Map<string, DiscoveryAssociation>();
    const m = new Map<string, DiscoveryAssociation>();
    for (const a of selected.associations) m.set(`${a.group}|${a.feature}`, a);
    return m;
  }, [selected]);

  const rows = useMemo(() => {
    if (!selected) return [] as DiscoveryAssociation[];
    return selected.associations.filter((a) => !onlySignificant || a.significant);
  }, [selected, onlySignificant]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-card/40">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4">
          <Button asChild variant="ghost" size="sm" className="min-h-11">
            <Link to="/">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Monitor
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-signal" />
            <div>
              <h1 className="text-lg font-semibold">Covariate–feature discovery</h1>
              <p className="text-xs text-muted-foreground">
                Where age, sex and agent move the EEG — and the COEBIS terms that follow
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm" className="ml-auto min-h-11">
            <Link to="/performance">Model performance</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Scanning stored spectral epochs…
          </div>
        ) : error ? (
          <p className="text-sm text-alert">{(error as Error).message}</p>
        ) : !selected ? (
          <p className="text-sm text-muted-foreground">
            No stored spectral epochs carry patient covariates yet. Import a dataset from Data
            exchange, or record cases with age, sex and regimen filed.
          </p>
        ) : (
          <>
            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={selected.lineage} onValueChange={setLineage}>
                  <SelectTrigger className="min-h-11 w-full sm:w-[320px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data!.lineages.map((l) => (
                      <SelectItem key={l.lineage} value={l.lineage}>
                        {l.lineage} · {l.cases} cases
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant={onlySignificant ? "default" : "outline"}
                  size="sm"
                  className="min-h-11"
                  onClick={() => setOnlySignificant((v) => !v)}
                >
                  {onlySignificant ? "Significant only" : "All tested cells"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {selected.cases} independent cases · {selected.epochs.toLocaleString()} epochs
                  analysed · statistics computed on case means, FDR-corrected within the lineage
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Covariate × feature effect map</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Largest level effect per cell, in pooled standard deviations. Blue = feature higher
                in that covariate level, red = lower. Empty cells were not testable in this lineage.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-xs">
                  <thead>
                    <tr>
                      <th className="p-2 text-left font-medium text-muted-foreground">Covariate</th>
                      {DISCOVERY_FEATURES.map((f) => (
                        <th key={f.key} className="p-2 text-center font-medium text-muted-foreground">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.key}>
                        <td className="p-2 font-medium">{g.label}</td>
                        {DISCOVERY_FEATURES.map((f: { key: FeatureKey }) => {
                          const a = matrix.get(`${g.key}|${f.key}`);
                          if (!a)
                            return (
                              <td key={f.key} className="p-1">
                                <div className="rounded bg-muted/20 py-2 text-center text-muted-foreground">
                                  —
                                </div>
                              </td>
                            );
                          const top = a.levels.reduce(
                            (best, l) => (Math.abs(l.effect) > Math.abs(best.effect) ? l : best),
                            a.levels[0]!,
                          );
                          return (
                            <td key={f.key} className="p-1">
                              <div
                                className={cn(
                                  "rounded px-1 py-2 text-center",
                                  cellTone(top.effect),
                                  a.significant && "ring-1 ring-current",
                                )}
                                title={`${top.label}: ${signed(top.effect)} SD (q=${fmt(a.q, 3)})`}
                              >
                                {signed(top.effect, 2)}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Associations</h2>
              {rows.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Nothing survives false-discovery correction in this lineage yet.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {rows.slice(0, 40).map((a) => (
                    <div
                      key={`${a.group}-${a.feature}`}
                      className="rounded-md border border-border/50 bg-background/40 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {a.groupLabel} → {a.featureLabel}
                        </span>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[11px]",
                            SUFFICIENCY_TONE[a.sufficiency],
                          )}
                        >
                          {a.sufficiency}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {a.rho != null ? `ρ ${fmt(a.rho, 2)} · ` : ""}η² {fmt(a.etaSquared, 2)} · q{" "}
                          {fmt(a.q, 3)} · {a.cases} cases
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {a.levels.map((l) => (
                          <div key={l.level} className="rounded bg-muted/30 px-2 py-1.5">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              {l.label} · {l.cases} cases
                            </p>
                            <p className="metric-value text-sm">
                              {fmt(l.mean, a.featureDp)} {a.featureUnit}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {signed(l.delta, a.featureDp)} vs lineage mean ({signed(l.effect, 2)}{" "}
                              SD)
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border/60 bg-card/40 p-4">
              <h2 className="text-sm font-semibold">Candidate COEBIS covariate terms</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Feature shifts translated into index points, shrunk by the number of independent
                cases and capped at ±6. These seed the covariate fit for this lineage only; a term
                is still promoted solely by the refit gate on paired reference readings.
              </p>
              {selected.candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No level shows a shift large or reliable enough to seed a term.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {selected.candidates.map((c) => (
                    <div
                      key={`${c.group}-${c.level}`}
                      className="rounded-md border border-border/50 bg-background/40 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {c.groupLabel}: {c.levelLabel}
                        </span>
                        <span
                          className={cn(
                            "metric-value text-sm",
                            c.dy > 0 ? "text-signal" : "text-alert",
                          )}
                        >
                          {signed(c.dy, 1)} pts
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {c.status === "candidate" ? "Candidate" : "Watch"} · {c.cases} cases ·
                        shrinkage ×{fmt(c.shrinkage, 2)} (raw {signed(c.rawDy, 1)})
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{c.rationale}</p>
                      <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                        {c.contributions.slice(0, 3).map((k) => (
                          <li key={k.feature}>
                            {k.featureLabel} {signed(k.delta, 3)} → {signed(k.indexPoints, 1)} pts
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
