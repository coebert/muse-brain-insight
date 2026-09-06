import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import { getHeadbandPool, refitHeadbandPool } from "@/lib/eeg/headband-pool.functions";
import type { HeadbandPoolReport } from "@/lib/eeg/headband-pool.server";
import { unseal } from "@/lib/privacy";

function num(v: number | null | undefined, dp = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

const OUTCOME_LABEL: Record<string, string> = {
  adverse: "Problem recorded",
  clean: "Uneventful",
  unrecorded: "Not recorded",
};

/**
 * What the headband model is actually learning from: every paired bedside
 * reading, the recording it came from and how that patient recovered.
 */
export function HeadbandPoolPanel() {
  const load = useServerFn(getHeadbandPool);
  const refit = useServerFn(refitHeadbandPool);
  const [result, setResult] = useState<HeadbandPoolReport | null>(null);
  const [running, setRunning] = useState(false);

  const query = useQuery({
    queryKey: ["headband-pool"],
    queryFn: async () => {
      const report = await load({ data: {} });
      const cases = (await unseal(
        report.cases as unknown as Record<string, unknown>[],
        ["caseCode"],
      )) as unknown as HeadbandPoolReport["cases"];
      return { ...report, cases };
    },
  });

  const report = result ?? query.data;

  async function run() {
    setRunning(true);
    try {
      const out = await refit({ data: {} });
      const cases = (await unseal(
        out.cases as unknown as Record<string, unknown>[],
        ["caseCode"],
      )) as unknown as HeadbandPoolReport["cases"];
      setResult({ ...out, cases });
      toast.success(out.promoted ? "New headband model applied." : "Refit finished — nothing applied.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The refit could not be run.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-5" /> Training pool and outcomes
          </CardTitle>
          <CardDescription>
            Every paired bedside reading that feeds the headband-only model, the recording it came
            from and how that patient recovered. Recoveries grade the fit; they never set the
            target, which is always the value the bedside monitor showed.
          </CardDescription>
        </div>
        <Button size="sm" onClick={run} disabled={running || query.isLoading}>
          {running ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Refit on the pool
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading the pool…</p>
        ) : query.isError ? (
          <p className="text-sm text-destructive">Could not load the pool.</p>
        ) : null}

        {report ? (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "Paired readings", value: report.readings.toLocaleString() },
                { label: "Recordings paired", value: `${report.pairedCases} of ${report.cases.length}` },
                { label: "Recoveries recorded", value: `${report.casesWithOutcome}` },
                { label: "With a problem", value: `${report.adverseCases}` },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-xl font-semibold tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>

            <p className="text-sm text-muted-foreground">{report.fit.outcomeNote}</p>

            <div className="rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {report.promoted
                  ? "Applied"
                  : report.fit.promote
                    ? "Would be applied"
                    : "Not applied"}
                {report.fit.provisional ? " · provisional" : ""}
              </p>
              <p className="text-muted-foreground">{report.fit.reason || "No candidate was fitted."}</p>
              <p className="mt-1 text-muted-foreground">
                Gap to the monitor, holding each recording out: {num(report.fit.before.mae, 2)} →{" "}
                {num(report.fit.after.mae, 2)} points across {report.fit.folds} recordings.
                {report.rejected ? ` ${report.rejected} readings were rejected before fitting.` : ""}
              </p>
            </div>

            {report.fit.deep ? (
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  Deep readings (monitor at or below {report.fit.deep.threshold})
                </p>
                <p className="text-muted-foreground">
                  {report.fit.deep.after.monitorDeep} of {report.readings} paired readings were deep
                  on the monitor. Before the fit the index called{" "}
                  {report.fit.deep.before.hits} of them deep (
                  {num(report.fit.deep.before.sensitivity, 0)}%); holding each recording out, the
                  new fit calls {report.fit.deep.after.hits} deep (
                  {num(report.fit.deep.after.sensitivity, 0)}%), while leaving{" "}
                  {num(report.fit.deep.after.specificity, 0)}% of the light readings light (was{" "}
                  {num(report.fit.deep.before.specificity, 0)}%). Deep readings carry{" "}
                  {report.fit.deep.weight}x weight when fitting; grading is unweighted.
                </p>
              </div>
            ) : null}

            <div>
              <p className="mb-2 text-sm font-medium">Held-out error by recovery</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recovery</TableHead>
                    <TableHead className="text-right">Recordings</TableHead>
                    <TableHead className="text-right">Readings</TableHead>
                    <TableHead className="text-right">Gap to monitor</TableHead>
                    <TableHead className="text-right">Within 10</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.fit.strata.map((s) => (
                    <TableRow key={s.outcome}>
                      <TableCell>{OUTCOME_LABEL[s.outcome]}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.cases}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.readings}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(s.agreement.mae, 2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.agreement.within10 == null
                          ? "—"
                          : `${Math.round(s.agreement.within10)}%`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">Recordings in the pool</p>
              <div className="max-h-80 overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recording</TableHead>
                      <TableHead className="text-right">Readings</TableHead>
                      <TableHead className="text-right">Scored epochs</TableHead>
                      <TableHead className="text-right">Average depth</TableHead>
                      <TableHead>Recovery</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.cases.map((c) => (
                      <TableRow key={c.sessionId}>
                        <TableCell className="font-medium">
                          {c.caseCode ?? c.sessionId.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.readings || <Badge variant="outline">none</Badge>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.epochs.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{num(c.meanDepth)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              c.outcome === "adverse"
                                ? "destructive"
                                : c.outcome === "clean"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {OUTCOME_LABEL[c.outcome]}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
