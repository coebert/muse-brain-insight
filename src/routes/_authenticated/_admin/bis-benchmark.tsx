import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Activity, BadgeCheck, ChevronDown, ChevronRight, Gauge } from "lucide-react";

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
import type { Agreement, LineageAgreement, Sufficiency } from "@/lib/eeg/bis-benchmark";
import { getBisBenchmark } from "@/lib/eeg/bis-benchmark.functions";
import { parseLineageKey } from "@/lib/eeg/model-lineage";

export const Route = createFileRoute("/_authenticated/_admin/bis-benchmark")({
  head: () => ({
    meta: [
      { title: "COEBIS vs recorded BIS — every paired case — CortexTrace" },
      {
        name: "description",
        content:
          "COEBIS graded against the recorded bedside BIS on every paired reading held, per acquisition lineage and per case, with the promoted BIS model's estimate on the same readings.",
      },
      { property: "og:title", content: "COEBIS vs recorded BIS — every paired case" },
      {
        property: "og:description",
        content:
          "Agreement between the app's depth index and the monitor's own BIS across all paired bedside readings, broken down by acquisition setup and case.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BisBenchmarkPage,
});

const SUFFICIENCY_LABEL: Record<Sufficiency, string> = {
  sufficient: "Sufficient sample",
  provisional: "Provisional",
  insufficient: "Too thin",
};

function lineageLabel(key: string): { title: string; detail: string } {
  const parsed = parseLineageKey(key);
  if (!parsed) return { title: key, detail: "" };
  const channels = parsed.channels.length ? parsed.channels.join("–") : "no montage";
  return {
    title: parsed.deviceId ?? key,
    detail: `${channels}${parsed.sampleRate ? ` · ${parsed.sampleRate} Hz` : ""}`,
  };
}

const n2 = (v: number | null, dp = 2) => (v == null ? "—" : v.toFixed(dp));
const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(0)}%`);

function SufficiencyBadge({ value }: { value: Sufficiency }) {
  if (value === "sufficient")
    return (
      <Badge className="gap-1 whitespace-nowrap">
        <BadgeCheck className="size-3" /> {SUFFICIENCY_LABEL[value]}
      </Badge>
    );
  return (
    <Badge variant={value === "provisional" ? "secondary" : "outline"} className="whitespace-nowrap">
      {SUFFICIENCY_LABEL[value]}
    </Badge>
  );
}

function AgreementRow({
  label,
  note,
  value,
}: {
  label: string;
  note?: string;
  value: Agreement;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{label}</div>
        {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">{value.n.toLocaleString()}</TableCell>
      <TableCell className="text-right tabular-nums">{n2(value.meanBis, 1)}</TableCell>
      <TableCell className="text-right tabular-nums">{n2(value.meanEstimate, 1)}</TableCell>
      <TableCell className="text-right tabular-nums">{n2(value.mae)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {value.bias == null ? "—" : `${value.bias > 0 ? "+" : ""}${value.bias.toFixed(2)}`}
      </TableCell>
      <TableCell className="text-right tabular-nums">{n2(value.correlation, 3)}</TableCell>
      <TableCell className="text-right tabular-nums">{pct(value.within5)}</TableCell>
      <TableCell className="text-right tabular-nums">{pct(value.within10)}</TableCell>
    </TableRow>
  );
}

function AgreementHead() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>Estimate</TableHead>
        <TableHead className="text-right">Readings</TableHead>
        <TableHead className="text-right">Mean BIS</TableHead>
        <TableHead className="text-right">Mean estimate</TableHead>
        <TableHead className="text-right">Avg error</TableHead>
        <TableHead className="text-right">Bias</TableHead>
        <TableHead className="text-right">Correlation</TableHead>
        <TableHead className="text-right">Within 5</TableHead>
        <TableHead className="text-right">Within 10</TableHead>
      </TableRow>
    </TableHeader>
  );
}

function LineageCard({ lineage }: { lineage: LineageAgreement }) {
  const [open, setOpen] = useState(false);
  const { title, detail } = lineageLabel(lineage.lineage);
  const shown = open ? lineage.cases : lineage.cases.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex items-center gap-2">
            <SufficiencyBadge value={lineage.sufficiency} />
            {lineage.modelInForce ? <Badge variant="secondary">BIS model in force</Badge> : null}
          </div>
        </div>
        <CardDescription>
          {detail} · {lineage.published.n.toLocaleString()} paired readings across{" "}
          {lineage.published.cases} case{lineage.published.cases === 1 ? "" : "s"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 overflow-x-auto">
        <Table>
          <AgreementHead />
          <TableBody>
            <AgreementRow
              label="What the app says today"
              note="COEBIS, or the raw index where no version is in force"
              value={lineage.published}
            />
            {lineage.model ? (
              <AgreementRow
                label="BIS model"
                note="the promoted version, read on exactly the same readings"
                value={lineage.model}
              />
            ) : null}
          </TableBody>
        </Table>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Per case, worst agreement first</h3>
            {lineage.cases.length > 8 ? (
              <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
                {open ? (
                  <>
                    <ChevronDown className="size-4" /> Show fewer
                  </>
                ) : (
                  <>
                    <ChevronRight className="size-4" /> All {lineage.cases.length} cases
                  </>
                )}
              </Button>
            ) : null}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead className="text-right">Readings</TableHead>
                <TableHead className="text-right">Mean BIS</TableHead>
                <TableHead className="text-right">Mean app</TableHead>
                <TableHead className="text-right">Avg error</TableHead>
                <TableHead className="text-right">Bias</TableHead>
                <TableHead className="text-right">Within 5</TableHead>
                <TableHead className="text-right">Model avg error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((c) => (
                <TableRow key={c.caseRef}>
                  <TableCell className="max-w-[16rem] truncate font-medium">{c.caseRef}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.published.n.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {n2(c.published.meanBis, 1)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {n2(c.published.meanEstimate, 1)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{n2(c.published.mae)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.published.bias == null
                      ? "—"
                      : `${c.published.bias > 0 ? "+" : ""}${c.published.bias.toFixed(2)}`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(c.published.within5)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.model ? n2(c.model.mae) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function BisBenchmarkPage() {
  const fetchBenchmark = useServerFn(getBisBenchmark);
  const report = useQuery({
    queryKey: ["bis-benchmark"],
    queryFn: () => fetchBenchmark({ data: { limit: 200000 } }),
    staleTime: 5 * 60 * 1000,
  });
  const data = report.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gauge className="size-6" /> COEBIS against recorded BIS
        </h1>
        <p className="text-sm text-muted-foreground">
          The suppression dashboard can only grade this on the handful of moments that carry both a
          full spectrum and a monitor number — two recordings. This page runs the same comparison on
          every paired bedside reading held, per acquisition setup and per case. A reading counts
          only where the monitor's own number and the app's number exist at the same moment; nothing
          is imputed, and the BIS model column is read on exactly the same readings.
        </p>
      </div>

      {report.isLoading ? (
        <p className="text-sm text-muted-foreground">Grading every paired reading…</p>
      ) : report.isError ? (
        <p className="text-sm text-destructive">Could not load the comparison.</p>
      ) : null}

      {data ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4" /> All setups pooled
            </CardTitle>
            <CardDescription>{data.verdict}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <AgreementHead />
              <TableBody>
                <AgreementRow
                  label="What the app says today"
                  note={`${data.totalCases} cases · ${data.lineages.length} acquisition setups`}
                  value={data.overall}
                />
                {data.overallModel ? (
                  <AgreementRow
                    label="BIS model"
                    note="only the readings a promoted version covers"
                    value={data.overallModel}
                  />
                ) : null}
              </TableBody>
            </Table>
            {data.unusable > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {data.unusable.toLocaleString()} readings were set aside as unreliable at the time
                and are not graded here.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {(data?.lineages ?? []).map((l) => (
        <LineageCard key={l.lineage} lineage={l} />
      ))}
    </div>
  );
}
