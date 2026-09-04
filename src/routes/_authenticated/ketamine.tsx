import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Eye, FlaskConical, Loader2, Minus } from "lucide-react";

import { AppNav } from "@/components/AppNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getKetamineCases } from "@/lib/eeg/ketamine-cases.functions";
import {
  ANAESTHESIA_THRESHOLD,
  type KetamineCaseSummary,
  type KetamineEffect,
} from "@/lib/eeg/ketamine-cases";
import { KETAMINE_CAP, KETAMINE_FLOOR } from "@/lib/eeg/ketamine";

export const Route = createFileRoute("/_authenticated/ketamine")({
  head: () => ({
    meta: [
      { title: "Ketamine signature per case — CortexTrace" },
      {
        name: "description",
        content:
          "The ketamine beta/gamma signature measured case by case, which recordings the bounded COEBIS correction is moving, and how each case grades on suppression and depth state.",
      },
      { property: "og:title", content: "Ketamine signature per case — CortexTrace" },
      {
        property: "og:description",
        content:
          "Fast-frequency share, alpha spindle loss and slow-wave preservation per case, with the correction applied and the suppression and depth-state grades behind it.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: KetaminePage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

const EFFECT_LABEL: Record<KetamineEffect, string> = {
  correcting: "Correcting",
  watched: "Declared, no movement",
  advisory: "Advisory only",
  quiet: "No pattern",
};

function EffectBadge({ effect }: { effect: KetamineEffect }) {
  if (effect === "correcting")
    return (
      <Badge className="gap-1 whitespace-nowrap">
        <Minus className="size-3" /> {EFFECT_LABEL[effect]}
      </Badge>
    );
  if (effect === "advisory")
    return (
      <Badge variant="secondary" className="gap-1 whitespace-nowrap">
        <AlertTriangle className="size-3" /> {EFFECT_LABEL[effect]}
      </Badge>
    );
  if (effect === "watched")
    return (
      <Badge variant="outline" className="gap-1 whitespace-nowrap">
        <Eye className="size-3" /> {EFFECT_LABEL[effect]}
      </Badge>
    );
  return (
    <Badge variant="outline" className="whitespace-nowrap text-muted-foreground">
      {EFFECT_LABEL[effect]}
    </Badge>
  );
}

function GradeBadge({ grade }: { grade: string }) {
  const tone =
    grade === "agrees" || grade === "separates"
      ? "bg-signal/15 text-signal border-signal/30"
      : grade === "insufficient"
        ? "bg-muted text-muted-foreground border-border"
        : "bg-amber-500/15 text-amber-500 border-amber-500/30";
  return (
    <Badge variant="outline" className={`${tone} whitespace-nowrap`}>
      {grade}
    </Badge>
  );
}

function pct(v: number | null | undefined, dp = 0): string {
  return v == null ? "—" : `${(v * 100).toFixed(dp)} %`;
}

function pts(v: number | null | undefined, dp = 1): string {
  return v == null ? "—" : v.toFixed(dp);
}

function CaseRow({ row }: { row: KetamineCaseSummary }) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <div>{row.caseRef}</div>
        <div className="text-muted-foreground">{row.lineage}</div>
      </TableCell>
      <TableCell>
        <EffectBadge effect={row.effect} />
        <div className="mt-1 text-xs text-muted-foreground">
          {row.declared ? "ketamine recorded" : "not recorded"} · {row.epochs} epochs
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <div>{pct(row.meanBetaGamma, 1)}</div>
        <div className="text-muted-foreground">peak {pct(row.maxBetaGamma, 1)}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <div>α {pct(row.meanAlpha, 1)}</div>
        <div className="text-muted-foreground">slow {pct(row.meanSlow, 1)}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <div>{row.maxScore.toFixed(2)} peak</div>
        <div className="text-muted-foreground">{pct(row.patternFraction)} of epochs</div>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <div>{row.correctedEpochs ? `${pts(row.meanDelta)} mean` : "—"}</div>
        <div className="text-muted-foreground">
          {row.correctedEpochs
            ? `worst ${pts(row.maxDelta)} · ${row.crossings} crossing${row.crossings === 1 ? "" : "s"}`
            : "no points removed"}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        <GradeBadge grade={row.suppression.grade} />
        <div className="mt-1 text-muted-foreground tabular-nums">
          {row.suppression.labelled
            ? `${row.suppression.suppressed}/${row.suppression.labelled} suppressed · app ${pts(row.suppression.appMeanSr)} %`
            : "no reference"}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        <GradeBadge grade={row.state.grade} />
        <div className="mt-1 text-muted-foreground tabular-nums">
          {row.state.anaesthetised || row.state.awake
            ? `anaes ${pts(row.state.meanAnaesthetised)} (n=${row.state.anaesthetised}) · awake ${pts(row.state.meanAwake)} (n=${row.state.awake})`
            : "no state labels"}
        </div>
      </TableCell>
    </TableRow>
  );
}

function KetaminePage() {
  const fetchCases = useServerFn(getKetamineCases);
  const { data, isLoading, error } = useQuery({
    queryKey: ["ketamine-cases"],
    queryFn: () => fetchCases({ data: {} }),
    staleTime: 5 * 60_000,
  });
  const [onlyAffected, setOnlyAffected] = useState(false);

  const rows = useMemo(() => {
    const all = data?.cases ?? [];
    return onlyAffected
      ? all.filter((c) => c.effect === "correcting" || c.effect === "advisory")
      : all;
  }, [data, onlyAffected]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 px-4 py-3">
        <AppNav />
      </header>
      <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <div className="space-y-2">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FlaskConical className="size-5 text-signal" /> Ketamine signature per case
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Ketamine augments 13–47 Hz power and flattens the frontal alpha spindle, so every
            ratio-based depth index reads high on it. COEBIS subtracts a bounded amount — at most{" "}
            {KETAMINE_CAP} points, never below {KETAMINE_FLOOR} on this rule alone — and only when
            ketamine is recorded for the case. A pattern with no record raises an advisory and moves
            nothing. Crossings count epochs the subtraction carries below the anaesthesia threshold
            of {ANAESTHESIA_THRESHOLD}, where it changes the clinical reading rather than just the
            number.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Measuring the spectrum across every stored
            case…
          </div>
        ) : error ? (
          <div role="alert" className="text-sm text-critical">
            {(error as Error).message}
          </div>
        ) : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "Cases measured", value: data.totals.cases },
                { label: "Ketamine recorded", value: data.totals.declaredCases },
                { label: "Cases being corrected", value: data.totals.correctingCases },
                { label: "Advisory (pattern, no record)", value: data.totals.advisoryCases },
              ].map((s) => (
                <Card key={s.label}>
                  <CardHeader className="pb-2">
                    <CardDescription>{s.label}</CardDescription>
                    <CardTitle className="text-2xl tabular-nums">{s.value}</CardTitle>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {data.totals.declaredCases === 0 ? (
              <Card className="border-amber-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">The subtraction is affecting no case yet</CardTitle>
                  <CardDescription>
                    No recording in the pool declares ketamine — the imported corpora are propofol or
                    volatile regimens, and no local case records it. The correction is therefore
                    inert everywhere below; what the table shows is where the ketamine-like spectral
                    pattern exists, which is what the advisory is for.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : null}

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Cases</CardTitle>
                  <CardDescription>
                    {data.totals.correctedEpochs.toLocaleString()} epochs corrected across{" "}
                    {data.totals.crossings.toLocaleString()} threshold crossings, from{" "}
                    {data.scanned.toLocaleString()} epochs read. Most affected first.
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => setOnlyAffected((v) => !v)}>
                  {onlyAffected ? "Show all cases" : "Only affected cases"}
                </Button>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Case</TableHead>
                      <TableHead>Ketamine stage</TableHead>
                      <TableHead className="text-right">13–47 Hz share</TableHead>
                      <TableHead className="text-right">Alpha / slow</TableHead>
                      <TableHead className="text-right">Pattern strength</TableHead>
                      <TableHead className="text-right">Correction</TableHead>
                      <TableHead>Suppression grade</TableHead>
                      <TableHead>Depth-state grade</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length ? (
                      rows.map((row) => <CaseRow key={`${row.lineage}/${row.caseRef}`} row={row} />)
                    ) : (
                      <TableRow>
                        <TableCell colSpan={8} className="text-sm text-muted-foreground">
                          No case matches this filter.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <p className="max-w-3xl text-xs text-muted-foreground">
              Grades come from labels recorded outside the app's analysis path: bedside suppression
              ratios and the source recordings' own state annotations. A case with too few labelled
              epochs is reported as <em>insufficient</em> rather than given a flattering score.
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
