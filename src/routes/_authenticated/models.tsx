import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BadgeCheck, CircleOff, History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getCoebisModelCatalog,
  type CoebisModelVersionRow,
} from "@/lib/eeg/coebis-models.functions";

export const Route = createFileRoute("/_authenticated/models")({
  head: () => ({
    meta: [
      { title: "COEBIS model versions — CortexTrace" },
      {
        name: "description",
        content:
          "Audit every COEBIS model version: held-out MAE and agreement, promotion and gate status, and the acquisition lineage each version was fitted on.",
      },
      { property: "og:title", content: "COEBIS model versions — CortexTrace" },
      {
        property: "og:description",
        content:
          "Per-version audit of fitted COEBIS depth models with held-out error, agreement, gate status and lineage provenance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ModelsPage,
});

const fmt = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);

function MetricsCell({ mae, ccc }: { mae: number | null | undefined; ccc: number | null | undefined }) {
  return (
    <div className="whitespace-nowrap tabular-nums">
      <div>MAE {fmt(mae)}</div>
      <div className="text-xs text-muted-foreground">CCC {fmt(ccc, 3)}</div>
    </div>
  );
}

function StatusBadge({ v }: { v: CoebisModelVersionRow }) {
  if (v.isActive)
    return (
      <Badge className="gap-1">
        <BadgeCheck className="size-3" /> Live
      </Badge>
    );
  if (v.promoted) return <Badge variant="secondary">Superseded</Badge>;
  return (
    <Badge variant="outline" className="gap-1">
      <CircleOff className="size-3" /> Candidate only
    </Badge>
  );
}

function ModelsPage() {
  const fetchCatalog = useServerFn(getCoebisModelCatalog);
  const catalog = useQuery({
    queryKey: ["coebis-model-catalog"],
    queryFn: () => fetchCatalog(),
  });

  const data = catalog.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <History className="size-6" /> COEBIS model versions
        </h1>
        <p className="text-sm text-muted-foreground">
          Every fitted version, grouped by acquisition lineage, with held-out error and agreement.
          Promotion requires the gate — {data?.gate.minPoints ?? 30} validated readings across{" "}
          {data?.gate.minCases ?? 3} independent cases — and a first fit goes live automatically
          only when it beats the published open index; later versions must beat the incumbent
          without losing agreement. Metrics are cross-validated (leave-one-case-out), never pooled
          across lineages.
        </p>
      </div>

      {catalog.isPending && (
        <p className="text-sm text-muted-foreground">Loading version history…</p>
      )}
      {catalog.isError && (
        <p className="text-sm text-destructive">
          Could not load the model catalogue: {(catalog.error as Error).message}
        </p>
      )}

      {data && data.lineages.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No COEBIS model has been fitted yet. Versions appear here once a lineage clears the
            gate and the refit pipeline runs.
          </CardContent>
        </Card>
      )}

      {data?.lineages.map((lineage) => (
        <Card key={lineage.lineageKey}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              <code className="rounded bg-muted px-2 py-0.5 text-sm">{lineage.lineageKey}</code>
              {lineage.activeVersion != null ? (
                <Badge>live: v{lineage.activeVersion}</Badge>
              ) : (
                <Badge variant="outline">no live model</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {lineage.versions.length} version{lineage.versions.length === 1 ? "" : "s"} fitted on
              this lineage.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Gate</TableHead>
                  <TableHead>Before</TableHead>
                  <TableHead>After (held-out)</TableHead>
                  <TableHead>Δ MAE</TableHead>
                  <TableHead>Fitted on</TableHead>
                  <TableHead>Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineage.versions.map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="whitespace-nowrap font-medium">
                      v{v.version}
                      <div className="text-xs text-muted-foreground">{v.family}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(v.createdAt).toLocaleDateString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge v={v} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {v.gate.cleared ? (
                        <Badge variant="secondary">cleared</Badge>
                      ) : (
                        <Badge variant="outline">below gate</Badge>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                        {v.gate.points.have}/{v.gate.points.need} readings · {v.gate.cases.have}/
                        {v.gate.cases.need} cases
                      </div>
                    </TableCell>
                    <TableCell>
                      <MetricsCell mae={v.before.mae} ccc={v.before.ccc} />
                      {v.before.source && (
                        <div className="text-xs text-muted-foreground">
                          {v.before.source === "raw_index" ? "open index" : "incumbent"}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <MetricsCell mae={v.after.mae} ccc={v.after.ccc} />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {v.maeGain == null ? (
                        "—"
                      ) : (
                        <span
                          className={
                            v.maeGain > 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : v.maeGain < 0
                                ? "text-destructive"
                                : undefined
                          }
                        >
                          {v.maeGain > 0 ? "−" : "+"}
                          {Math.abs(v.maeGain).toFixed(2)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 text-xs text-muted-foreground">
                      {v.trainingText}
                    </TableCell>
                    <TableCell className="max-w-80 text-xs">
                      {v.reason ?? v.verdict}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
