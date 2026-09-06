import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, BadgeCheck, Layers, Lock, Sparkles } from "lucide-react";

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
import type { BlockerStatus, CovariateOpportunity, CovariateStatus } from "@/lib/eeg/coebis-blockers";
import { getCoebisBlockers } from "@/lib/eeg/coebis-blockers.functions";

export const Route = createFileRoute("/_authenticated/_admin/blockers")({
  head: () => ({
    meta: [
      { title: "Blocked lineages & covariate headroom — CortexTrace" },
      {
        name: "description",
        content:
          "Which acquisition lineages have no live COEBIS model, how many further independent cases each needs to cross-validate, and which covariates carry enough case variation to improve the fit.",
      },
      { property: "og:title", content: "Blocked lineages & covariate headroom — CortexTrace" },
      {
        property: "og:description",
        content:
          "Gate status per acquisition lineage, cases still needed for leave-one-case-out validation, and covariates ready to earn a COEBIS term.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BlockersPage,
});

const STATUS_LABEL: Record<BlockerStatus, string> = {
  live: "Live",
  provisional: "Provisional",
  "awaiting-refit": "Awaiting refit",
  evidence: "Blocked on evidence",
  cases: "Blocked on cases",
  readings: "Blocked on readings",
  unattributed: "No lineage",
};

function StatusBadge({ status }: { status: BlockerStatus }) {
  if (status === "live")
    return (
      <Badge className="gap-1 whitespace-nowrap">
        <BadgeCheck className="size-3" /> {STATUS_LABEL[status]}
      </Badge>
    );
  if (status === "provisional")
    return (
      <Badge variant="secondary" className="whitespace-nowrap">
        {STATUS_LABEL[status]}
      </Badge>
    );
  if (status === "awaiting-refit")
    return (
      <Badge variant="secondary" className="whitespace-nowrap">
        {STATUS_LABEL[status]}
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1 whitespace-nowrap">
      <Lock className="size-3" /> {STATUS_LABEL[status]}
    </Badge>
  );
}

const COV_LABEL: Record<CovariateStatus, string> = {
  ready: "Ready to fit",
  sparse: "Too thin",
  constant: "Constant",
  missing: "Not recorded",
};

function CovariateBadge({ status }: { status: CovariateStatus }) {
  return (
    <Badge
      variant={status === "ready" ? "default" : status === "sparse" ? "secondary" : "outline"}
      className="whitespace-nowrap"
    >
      {COV_LABEL[status]}
    </Badge>
  );
}

function CovariateTable({ rows }: { rows: CovariateOpportunity[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Covariate</TableHead>
          <TableHead className="text-right">Reading coverage</TableHead>
          <TableHead className="text-right">Levels (2+ cases)</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>What it would take</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((c) => (
          <TableRow key={c.group}>
            <TableCell className="font-medium">
              {c.label}
              {c.levels.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {c.levels
                    .slice(0, 4)
                    .map((l) => `${l.level} (${l.cases})`)
                    .join(", ")}
                  {c.levels.length > 4 ? ` +${c.levels.length - 4} more` : ""}
                </div>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {Math.round(c.coverage * 100)}%
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {c.usableLevels} / {c.levels.length}
            </TableCell>
            <TableCell>
              <CovariateBadge status={c.status} />
            </TableCell>
            <TableCell className="max-w-md text-xs text-muted-foreground">{c.advice}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BlockersPage() {
  const fetchBlockers = useServerFn(getCoebisBlockers);
  const report = useQuery({
    queryKey: ["coebis-blockers"],
    queryFn: () => fetchBlockers(),
  });

  const data = report.data;
  const blocked = data?.lineages.filter((l) => l.blocked) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Lock className="size-6" /> Blocked lineages
        </h1>
        <p className="text-sm text-muted-foreground">
          A COEBIS model is only fitted per acquisition lineage, and only promoted when it beats the
          model in force on cases it never saw. This page separates the two reasons a lineage has no
          live model: not enough independent cases to cross-validate on (collect more patients), and
          enough data but no candidate that improved on the reference (more of the same readings will
          not help). The gate is {data?.gate.minPoints ?? 30} validated readings across{" "}
          {data?.gate.minCases ?? 3} cases; {data?.gate.stableCases ?? 10} case-folds is where a
          leave-one-case-out estimate stops being coarse.
        </p>
      </div>

      {report.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading gate status…</p>
      ) : report.isError ? (
        <p className="text-sm text-destructive">Could not load gate status.</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4" /> Gate status per lineage
          </CardTitle>
          <CardDescription>
            {data
              ? `${blocked.length} of ${data.lineages.length} lineages have no live model, over ${data.validatedPoints.toLocaleString()} validated readings.`
              : "Every acquisition setup that has contributed paired readings."}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lineage</TableHead>
                <TableHead className="text-right">Readings</TableHead>
                <TableHead className="text-right">Cases</TableHead>
                <TableHead className="text-right">Cases needed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.lineages ?? []).map((l) => (
                <TableRow key={l.lineageKey}>
                  <TableCell className="font-medium">
                    {l.deviceId ?? l.lineageKey}
                    <div className="text-xs text-muted-foreground">
                      {l.channels.length ? l.channels.join("–") : "no montage"}
                      {l.sampleRate ? ` · ${l.sampleRate} Hz` : ""}
                      {l.activeVersion ? ` · v${l.activeVersion} live` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.readings.toLocaleString()}
                    {l.readingsNeeded > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        +{l.readingsNeeded} to gate
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.cases}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.casesNeeded > 0 ? l.casesNeeded : "—"}
                    {l.casesNeeded === 0 && l.casesForStableCv > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        +{l.casesForStableCv} for a stable CV
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={l.status} />
                    <div className="mt-1 text-xs text-muted-foreground">{l.headline}</div>
                  </TableCell>
                  <TableCell className="max-w-md text-xs text-muted-foreground">{l.detail}</TableCell>
                </TableRow>
              ))}
              {data && data.lineages.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-sm text-muted-foreground">
                    No paired readings have been filed yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" /> Covariates that could improve COEBIS
          </CardTitle>
          <CardDescription>
            Pooled across every lineage. A covariate only earns a term when it varies across
            independent cases — one long case supplying thousands of epochs at a single age band is
            still one case, so level counts below are cases, not readings.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data ? <CovariateTable rows={data.pooledCovariates} /> : null}
        </CardContent>
      </Card>

      {(data?.perLineageCovariates ?? []).map((l) => (
        <Card key={l.lineageKey}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" /> {l.lineageKey}
            </CardTitle>
            <CardDescription>
              Covariate headroom within this lineage alone ({l.readings.toLocaleString()} validated
              readings). A covariate that discriminates in theatre data can be constant in an ICU
              cohort, so a term is only worth fitting where it varies.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <CovariateTable rows={l.covariates} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
