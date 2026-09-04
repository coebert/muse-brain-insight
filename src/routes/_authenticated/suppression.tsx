import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, CheckCircle2, Loader2, ShieldAlert, Waves } from "lucide-react";

import { AppNav } from "@/components/AppNav";
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
import { getSuppressionReport } from "@/lib/eeg/suppression-model.functions";
import {
  CAP_FULL_PCT,
  CAP_ONSET_PCT,
  MAX_INDEX_CAP_SHIFT,
  MONITOR_SUPPRESSED_PCT,
  type SrAgreement,
  type SrDetection,
  type SuppressionGrade,
  type SuppressionReport,
} from "@/lib/eeg/suppression-model";

export const Route = createFileRoute("/_authenticated/suppression")({
  head: () => ({
    meta: [
      { title: "Suppression model graded against monitor SR — CortexTrace" },
      {
        name: "description",
        content:
          "A suppression model fitted separately from COEBIS on VitalDB suppression-ratio labels, paired with the depth index as a bounded cap, and graded on held-out cases against the monitor's own suppression ratio.",
      },
      {
        property: "og:title",
        content: "Suppression model graded against monitor SR — CortexTrace",
      },
      {
        property: "og:description",
        content:
          "Held-out agreement and detection for the suppression fit, before and after, plus what the pairing with COEBIS changes inside recorded suppression.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SuppressionPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
});

function num(v: number | null, dp = 1, suffix = ""): string {
  return v == null ? "—" : `${v.toFixed(dp)}${suffix}`;
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One before/after pair, so the fit is always read against the raw detector. */
function BeforeAfter({
  label,
  before,
  after,
  dp = 1,
  suffix = "",
  lowerIsBetter,
}: {
  label: string;
  before: number | null;
  after: number | null;
  dp?: number;
  suffix?: string;
  lowerIsBetter: boolean;
}) {
  const improved =
    before != null && after != null
      ? lowerIsBetter
        ? after < before
        : after > before
      : null;
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">
        <span className="text-muted-foreground">{num(before, dp, suffix)}</span>
        <span className="mx-1.5 text-muted-foreground">→</span>
        <span
          className={
            improved === null ? "" : improved ? "text-success" : "text-critical"
          }
        >
          {num(after, dp, suffix)}
        </span>
      </p>
    </div>
  );
}

function AgreementRow({ before, after }: { before: SrAgreement; after: SrAgreement }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <BeforeAfter label="Mean error" before={before.mae} after={after.mae} suffix=" SR pts" lowerIsBetter />
      <BeforeAfter
        label="Bias"
        before={before.bias}
        after={after.bias}
        suffix=" SR pts"
        lowerIsBetter
      />
      <BeforeAfter
        label="Correlation"
        before={before.r}
        after={after.r}
        dp={2}
        lowerIsBetter={false}
      />
    </div>
  );
}

function DetectionRow({ before, after }: { before: SrDetection; after: SrDetection }) {
  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <BeforeAfter label="AUC" before={before.auc} after={after.auc} dp={2} lowerIsBetter={false} />
      <BeforeAfter
        label="Sensitivity"
        before={before.sensitivity}
        after={after.sensitivity}
        dp={2}
        lowerIsBetter={false}
      />
      <BeforeAfter
        label="Specificity"
        before={before.specificity}
        after={after.specificity}
        dp={2}
        lowerIsBetter={false}
      />
      <BeforeAfter
        label="Suppression missed"
        before={before.missed}
        after={after.missed}
        dp={0}
        lowerIsBetter
      />
    </div>
  );
}

function GradeCard({
  title,
  description,
  before,
  after,
}: {
  title: string;
  description: string;
  before: SuppressionGrade;
  after: SuppressionGrade;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <AgreementRow before={before.agreement} after={after.agreement} />
        <DetectionRow before={before.detection} after={after.detection} />
        <p className="text-xs text-muted-foreground">
          {after.agreement.n.toLocaleString()} held-out readings from{" "}
          {after.agreement.cases} cases ·{" "}
          {after.detection.suppressed.toLocaleString()} at or above{" "}
          {MONITOR_SUPPRESSED_PCT}% monitor suppression,{" "}
          {after.detection.clear.toLocaleString()} below it.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The calibration in force, and the only way to put one there.
 *
 * Promotion re-runs the fit server-side and refuses anything the gate blocks,
 * so this button cannot push through a calibration the grading rejected.
 */
function ActiveModelPanel({ fitPromotable }: { fitPromotable: boolean }) {
  const queryClient = useQueryClient();
  const fetchActive = useServerFn(getActiveSuppressionModel);
  const promote = useServerFn(promoteSuppressionModel);
  const { data: active } = useQuery({
    queryKey: ["suppression-active-model"],
    queryFn: () => fetchActive({}),
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: () => promote({ data: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["suppression-active-model"] }),
  });

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">
            {active
              ? `In force: v${active.version} on ${active.lineage}`
              : "No calibration is in force yet"}
          </p>
          <p className="text-xs text-muted-foreground">
            {active
              ? `${active.model.n.toLocaleString()} readings from ${active.model.cases} cases · ${
                  active.sensitivityGain == null
                    ? "—"
                    : `${(active.sensitivityGain * 100).toFixed(1)} pts more suppression found`
                } · promoted ${new Date(active.createdAt).toLocaleDateString()}`
              : "Until one is promoted, the raw flat-time detector is what the app uses."}
          </p>
        </div>
        <Button
          size="sm"
          variant={active ? "outline" : "default"}
          disabled={!fitPromotable || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="mr-1 size-3 animate-spin" /> Refitting…
            </>
          ) : active ? (
            "Refit and promote"
          ) : (
            "Promote this fit"
          )}
        </Button>
      </div>
      {mutation.data ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {mutation.data.promoted ? "Promoted: " : "Not promoted: "}
          {mutation.data.reason}.
        </p>
      ) : null}
      {mutation.isError ? (
        <p className="mt-2 text-xs text-critical">{(mutation.error as Error).message}</p>
      ) : null}
    </div>
  );
}


  const fetchReport = useServerFn(getSuppressionReport);
  const { data, isLoading } = useQuery<SuppressionReport>({
    queryKey: ["suppression-model"],
    queryFn: () => fetchReport({ data: {} }),
    staleTime: 60_000,
  });

  return (
    <div className="min-h-screen bg-background">
      <AppNav />
      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header className="space-y-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Waves className="size-6 text-primary" /> Suppression model
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Burst suppression and anaesthetic depth are two different
            measurements, so this is a separate model with its own ground truth:
            the monitor's recorded suppression ratio. It is fitted on the app's
            own flat-time detector, cross-validated case by case, then paired
            with COEBIS as a one-sided cap — the depth number can be pulled down
            when the record is largely flat, never pushed up.
          </p>
        </header>

        {isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Fitting on the recorded
            suppression labels…
          </div>
        ) : !data || !data.fit.points ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No readings carry both an app suppression ratio and a monitor
              suppression ratio yet, so there is nothing to fit against.
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  The fit
                  {data.fit.promotable ? (
                    <Badge className="gap-1">
                      <CheckCircle2 className="size-3" /> Clears the gate
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1">
                      <ShieldAlert className="size-3" /> Held back
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {data.fit.points.toLocaleString()} paired readings from{" "}
                  {data.fit.cases} cases on the {data.fit.lineage} lineage,{" "}
                  {data.fit.suppressedPoints.toLocaleString()} of them with
                  recorded suppression, split into {data.fit.folds} folds by
                  case.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric
                    label="Suppression found"
                    value={
                      data.fit.sensitivityGain == null
                        ? "—"
                        : `${data.fit.sensitivityGain > 0 ? "+" : ""}${(data.fit.sensitivityGain * 100).toFixed(1)} pts`
                    }
                    hint="Extra recorded suppression caught, held out"
                  />
                  <Metric
                    label="Accuracy cost"
                    value={num(data.fit.maeGain, 2, " SR pts")}
                    hint="Negative means error rose elsewhere"
                  />
                  <Metric
                    label="Readings"
                    value={data.fit.points.toLocaleString()}
                    hint={`${data.fit.cases} independent cases`}
                  />
                  <Metric
                    label="Suppressed readings"
                    value={data.fit.suppressedPoints.toLocaleString()}
                    hint={`At or above ${MONITOR_SUPPRESSED_PCT}% monitor SR`}
                  />
                </div>

                {data.fit.blockedBy ? (
                  <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                    Not promoted: {data.fit.blockedBy}.
                  </p>
                ) : (
                  <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                    On cases it never saw, the calibration catches suppression
                    the raw detector misses. It is not more accurate on average
                    — it reads slightly high on clear stretches — so it is used
                    to lower the depth number, never to reassure.
                  </p>

                )}

                <ActiveModelPanel fitPromotable={data.fit.promotable} />
              </CardContent>
            </Card>


            <GradeCard
              title="Graded against the monitor's suppression ratio"
              description="Held-out cases only — the raw detector on the left of each pair, the fitted model on the right."
              before={data.fit.before}
              after={data.fit.after}
            />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ArrowDown className="size-4" /> Paired with COEBIS
                </CardTitle>
                <CardDescription>
                  Above {CAP_ONSET_PCT}% estimated suppression the cap starts to
                  bite, reaching its full {MAX_INDEX_CAP_SHIFT}-point limit at{" "}
                  {CAP_FULL_PCT}%. It only ever lowers the index.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <BeforeAfter
                    label="COEBIS error vs monitor"
                    before={data.pairing.maeBefore}
                    after={data.pairing.maeAfter}
                    suffix=" pts"
                    lowerIsBetter
                  />
                  <BeforeAfter
                    label="Read light inside suppression"
                    before={data.pairing.falselyLightBefore}
                    after={data.pairing.falselyLightAfter}
                    dp={0}
                    lowerIsBetter
                  />
                  <Metric
                    label="Cap engaged"
                    value={data.pairing.engaged.toLocaleString()}
                    hint={`readings across ${data.pairing.cases} cases`}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  A depth index that reads light while the monitor records
                  suppression is the failure this pairing exists to prevent. The
                  cap is bounded on purpose: it corrects an obvious
                  contradiction, it does not become a second depth model.
                </p>
              </CardContent>
            </Card>

            {data.worstCases.length ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Where the raw detector disagreed most
                  </CardTitle>
                  <CardDescription>
                    Cases ranked by how far the app's own suppression ratio sat
                    from the monitor's, with what the fit does to each.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Case</TableHead>
                        <TableHead className="text-right">Readings</TableHead>
                        <TableHead className="text-right">App SR</TableHead>
                        <TableHead className="text-right">Monitor SR</TableHead>
                        <TableHead className="text-right">Error before</TableHead>
                        <TableHead className="text-right">Error after</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.worstCases.map((c) => (
                        <TableRow key={c.caseRef}>
                          <TableCell className="font-medium">{c.caseRef}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.points.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.meanAppSr.toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.meanMonitorSr.toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {c.maeBefore.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {num(c.maeAfter, 1)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
